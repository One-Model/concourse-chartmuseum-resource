#!/usr/bin/env node

import * as os from "os";
import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as util from "util";
import * as semver from "semver";
import * as rimraf from "rimraf";
import * as FormData from "form-data";

import fetch, { Response } from "node-fetch";
import * as tmp from "tmp";
import * as yaml from "yamljs";
import { retry } from 'ts-retry-promise';

import { retrieveRequestFromStdin, createFetchAgent, createFetchHeaders, Repository } from "./index";
import { OutRequest, OutResponse } from "./index";

const exec = util.promisify(child_process.exec);
const lstat = util.promisify(fs.lstat);
const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);
const mkdtemp = util.promisify(fs.mkdtemp);
const deltree = util.promisify(rimraf);

async function createTmpDir(): Promise<{ path: string, cleanupCallback: () => void }> {
    return new Promise<{ path: string, cleanupCallback: () => void }>((resolve, reject) => {
        tmp.dir((err, path, cleanupCallback) => {
            if (err) {
                reject(err);
            } else {
                resolve({
                    path: path,
                    cleanupCallback: cleanupCallback
                });
            }
        });
    });
}

async function importGpgKey(gpgHome: string, keyFile: string, passphrase?: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let importResult = "";
        const importProcess = child_process.spawn("gpg", [
            "--batch",
            "--homedir",
            `"${path.resolve(gpgHome)}"`,
            "--import",
            `"${path.resolve(keyFile)}"`
        ]);
        if (passphrase != null) {
            importProcess.stdin.write(passphrase);
        }
        importProcess.stdin.end();
        importProcess.stderr.on("data", data => {
            importResult += data;
        });
        importProcess.stdout.on("data", data => {
            process.stderr.write(JSON.stringify(data));
        });
        importProcess.on("close", code => {
            if (code != 0) {
                reject(new Error(`gpg import returned exit code ${code}.`));
            } else {
                const keyIdLine = importResult.split(/\r?\n/).find(line => line.includes("secret key imported"));
                if (keyIdLine == null) {
                    reject("Unable to determine Key ID after successful import: Line with key ID not found.");
                } else {
                    const match = /^gpg\:\ key\ (.*?)\: secret\ key\ imported$/.exec(keyIdLine);
                    if (match == null) {
                        reject("Unable to determine Key ID after successful import: Regex match failure.")
                    } else {
                        resolve(match[1]);
                    }
                }
            }
        });
    });
}

export default async function out(): Promise<{ data: Object, cleanupCallback: (() => void) | undefined }> {

    let cleanupCallback: (() => void) | undefined = undefined;

    // Determine build path and decend into it.
    if (process.argv.length != 3) {
        process.stderr.write(`Expected exactly one argument (root), got ${process.argv.length - 2}.\n`);
        process.exit(102);
    }
    const root = path.resolve(process.argv[2]);
    process.chdir(root);

    let request: OutRequest;
    try {
        request = await retrieveRequestFromStdin<OutRequest>();
    } catch (e) {
        process.stderr.write("Unable to retrieve JSON data from stdin.\n");
        process.stderr.write(JSON.stringify(e));
        process.exit(502)
        throw (e);
    }

    let headers = createFetchHeaders(request);

    const agent = createFetchAgent(request);

    // If either params.version or params.version_file have been specified,
    // we'll read our version information for packaging the Helm Chart from
    // there.
    let version = request.params.version;
    if (request.params.version_file != null) {
        const versionFile = path.resolve(request.params.version_file);
        if ((await lstat(versionFile)).isFile()) {
            // version_file exists. Cool... let's read it's contents.
            version = (await readFile(versionFile)).toString().replace(/\r?\n/, "")
        }
    }
    if (version != null && request.source.version_range != null) {
        const versionRange = request.source.version_range;
        if (!semver.satisfies(version, versionRange)) {
            process.stderr.write(`params.version (${version}) does not satisfy contents of source.version_range (${versionRange}).\n`)
            process.exit(104);
        }
    }

    // Add Remote Helm Repo Dependencies
    if (request.params.dependency_repos != null) {
        process.stderr.write(`Processing chart Helm Repo Dependencies...\n`)
        for (const [name, repo] of Object.entries(request.params.dependency_repos)) {
            let addCmd = [
                "helm",
                "repo",
                "add"
            ];

            if (repo.basic_auth_username != null && repo.basic_auth_password != null) {
                addCmd.push("--username");
                addCmd.push(repo.basic_auth_username );
                addCmd.push("--password");
                addCmd.push(repo.basic_auth_password );
            }

            if (repo.tls_ca_cert != null) {
                const caDir = await createTmpDir();

                addCmd.push("--ca-file");
                let caFile = path.resolve(caDir.path, "ca.pem");
                await writeFile(caFile, repo.tls_ca_cert);
                addCmd.push(caFile);
            }

            if (repo.tls_client_cert != null && repo.tls_client_key != null) {
                const tlsDir = await createTmpDir();

                addCmd.push("--cert-file");
                let certFile = path.resolve(tlsDir.path, "cert.pem");
                await writeFile(certFile, repo.tls_client_cert);
                addCmd.push(certFile);


                addCmd.push("--key-file");
                let keyFile = path.resolve(tlsDir.path, "key.pem");
                await writeFile(keyFile, repo.tls_client_key);
                addCmd.push(keyFile);
            }
            
            addCmd.push(name);
            addCmd.push(repo.server_url);

            try {
                process.stderr.write(`Performing \"helm add ${name} ${repo.server_url}\"...\n`);
                await exec(addCmd.join(" "));
            } catch (e) {
                if (e.stderr != null) {
                    process.stderr.write(`${e.stderr}\n`);
                }
                process.stderr.write(`Adding Helm Repo failed.\n`);
                process.exit(193);
            }
        }
    }

    const chartLocation = path.resolve(request.params.chart);
    process.stderr.write(`Processing chart at "${chartLocation}"...\n`)
    let chartFile: string;
    let chartFileStat = await lstat(chartLocation);
    if (chartFileStat.isDirectory()) {
        const chartInfo = yaml.load(path.resolve(chartLocation, "Chart.yaml"));
        const tmpDir = await createTmpDir();
        cleanupCallback = tmpDir.cleanupCallback;
        const cmd = [
            "helm",
            "package",
            "--destination",
            tmpDir.path
        ];
        if (request.params.dependency_update === true) {
          cmd.push("--dependency-update");
        }
        if (request.params.sign === true) {
            const keyData = request.params.key_data;
            let keyFile = request.params.key_file;
            let keyId: string;
            if (keyData == null && keyFile == null) {
                process.stderr.write("Either key_data or key_file must be specified, when 'sign' is set to true.");
                process.exit(332)
            }
            if (keyData != null) {
                keyFile = path.resolve(tmpDir.path, "gpg-key.asc");
                await writeFile(keyFile, keyData);
            }
            const gpgHome: string = path.resolve(await mkdtemp(path.resolve(os.tmpdir(), "concourse-gpg-keyring-")));
            process.stderr.write(`Using new empty temporary GNUPGHOME: "${gpgHome}".\n`)
            try {
                process.stderr.write(`Importing GPG private key: "${keyFile}"...\n`);
                try {
                    keyId = await importGpgKey(gpgHome, keyFile as string, request.params.key_passphrase);
                } catch (e) {
                    process.stderr.write(`Importing of GPG key "${keyFile}" failed.\n`);
                    throw e;
                }
                process.stderr.write(`GPG key imported successfully. Key ID: "${keyId}".\n`);
                cmd.push("--sign");
                cmd.push("--key");
                cmd.push(keyId);
                cmd.push("--keyring");
                cmd.push(`"${path.resolve(gpgHome, "secring.gpg")}"`);
            } catch (e) {
                process.stderr.write("Signing of chart with GPG private key failed\n");
                throw e;
            } finally {
                process.stderr.write(`Removing temporary GNUPGHOME "${gpgHome}".\n`)
                await deltree(gpgHome);
            }

        }
        if (version != null) {
            cmd.push("--version", version);
        }
        cmd.push(chartLocation);
        try {
            process.stderr.write("Performing \"helm package\"...\n");
            await exec(cmd.join(" "));
        } catch (e) {
            if (e.stderr != null) {
                process.stderr.write(`${e.stderr}\n`);
            }
            process.stderr.write(`Packaging of chart file failed.\n`);
            process.exit(121);
        }
        chartFile = path.resolve(tmpDir.path, `${chartInfo.name}-${version != null ? version : chartInfo.version}.tgz`);
        chartFileStat = await lstat(chartFile);
    } else if (chartFileStat.isFile()) {
        chartFile = chartLocation;
    } else {
        process.stderr.write(`Chart file (${chartLocation}) not found.\n`)
        process.exit(110);
        throw new Error(); // Tricking the typescript compiler.
    }

    process.stderr.write(`Inspecting chart file: "${chartFile}"...\n`)

    try {
        const result = await exec(`helm inspect chart ${chartFile}`);
        if (result.stderr != null && result.stderr.length > 0) {
            process.stderr.write(`${result.stderr}\n`);
        }
        const inspectionResult = result.stdout;
        const versionLine = inspectionResult.split(/\r?\n/).find(line => line.startsWith("version:"));
        if (versionLine == null) {
            process.stderr.write("Unable to parse version information from Helm Chart inspection result.\n");
            process.exit(121);
        } else {
            version = versionLine.split(/version:\s*/)[1]
        }
    } catch (e) {
        process.stderr.write(`Unable to "inspect" Helm Chart file: ${chartFile}.\n`);
        process.exit(120);
    }

    var body;
    if (request.source.harbor_api === true) {
        // Update for multipart uploads required by harbor API
        body = new FormData();
        body.append('chart', fs.createReadStream(chartFile));
    } else {
        headers.append("Content-length", String(chartFileStat.size))
        headers.append("Content-Disposition", `attachment; filename="${path.basename(chartFile)}"`)
        body = fs.createReadStream(chartFile);
    }
    process.stderr.write(`Uploading chart file: "${chartFile}"...\n`);

    let postResult: Response;
    try {
        let postUrl = `${request.source.server_url}`;
        if (request.params.force) {
            postUrl += "?force=true"
        }
        postResult = await fetch(postUrl, {
            method: "POST",
            agent: agent,
            headers: headers,
            body: body
        });
    } catch (e) {
        process.stderr.write(`Upload of chart file to "${request.source.server_url}" has failed.\n`);
        process.stderr.write(JSON.stringify(JSON.stringify(e)));
        process.exit(124);
        throw e; // Tricking the typescript compiler.
    }

    if (postResult.status != 201) {
        process.stderr.write(`An error occured while uploading the chart to "${request.source.server_url}" : "${postResult.status} - ${postResult.statusText}".\n`);
        process.exit(postResult.status);
    }

    const postResultJson = await postResult.json();
    if (postResultJson.error != null) {
        process.stderr.write(`An error occured while uploading the chart: "${postResultJson.error}".\n`);
        process.exit(602);
    } else if (postResultJson.saved !== true) {
        process.stderr.write(`Helm chart has not been saved. (Return value from server: saved=${postResultJson.saved})\n`)
        process.exit(603)
    }

    process.stderr.write("Helm Chart has been uploaded.\n")
    process.stderr.write(`- Name: ${request.source.chart_name}\n`)
    process.stderr.write(`- Version: ${version}\n\n`);

    // Fetch Chart that has just been uploaded.
    headers = createFetchHeaders(request); // We need new headers. (Content-Length should be "0" again...)
    const chartInfoUrl = `${request.source.server_url}/${request.source.chart_name}/${version}`;
    process.stderr.write(`Fetching chart data from "${chartInfoUrl}"...\n`);

    const chartResp = await fetch(
        `${request.source.server_url}/${request.source.chart_name}/${version}`,
        { agent: agent, headers: headers });

    if (!chartResp.ok) {
        process.stderr.write("Download of chart information failed.\n")
        process.stderr.write((await chartResp.buffer()).toString());
        process.exit(710);
    }
    const chartJson = await chartResp.json();

    if (request.source.harbor_api === true) {
        if (version != chartJson.metadata.version) {
            process.stderr.write(`Version mismatch in uploaded Helm Chart. Got: ${chartJson.metadata.version}, expected: ${version}.\n`);
            process.exit(203);
        }
    } else {
        if (version != chartJson.version) {
            process.stderr.write(`Version mismatch in uploaded Helm Chart. Got: ${chartJson.version}, expected: ${version}.\n`);
            process.exit(203);
        }
    }

    if (request.source.harbor_api === true) {
        const response: OutResponse = {
            version: {
                version: chartJson.metadata.version,
                digest: chartJson.metadata.digest
            },
            metadata: [
                { name: "created", value: chartJson.metadata.created },
                { name: "description", value: chartJson.metadata.description },
                { name: "appVersion", value: chartJson.appVersion }
            ]
        };
        return {
            data: response,
            cleanupCallback: cleanupCallback
        }
    } else {
        const response: OutResponse = {
            version: {
                version: chartJson.version,
                digest: chartJson.digest
            },
            metadata: [
                { name: "created", value: chartJson.created },
                { name: "description", value: chartJson.description },
                { name: "appVersion", value: chartJson.appVersion },
                { name: "home", value: chartJson.home },
                { name: "tillerVersion", value: chartJson.tillerVersion },
            ]
        };
        return {
            data: response,
            cleanupCallback: cleanupCallback
        }
    }

}

(async () => {
    process.on("unhandledRejection", err => {
        process.stderr.write(err != null ? err.toString() : "UNKNOWN ERROR");
        process.exit(-1);
    });
    try {
        const result = await out();
        if (typeof result.cleanupCallback === "function") {
            process.stderr.write("Cleaning up...\n");
            //result.cleanupCallback(); // TODO(b.jung) The cleanup callbck causes an error. :-(
        }
        process.stdout.write(JSON.stringify(result.data));
        process.exit(0);
    } catch (e) {
        process.stderr.write("\n\nAn unexpected error occured.\n");
        process.stderr.write(JSON.stringify(e));
        process.exit(1);
    }
})();
