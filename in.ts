#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import * as util from "util";

import fetch from "node-fetch";

import { retrieveRequestFromStdin, createFetchHeaders } from "./index";
import { InRequest, InResponse } from "./index";

// Promisified funtions from the Node.js standard library.
const writeFile = util.promisify(fs.writeFile);

(async () => {

    // Determine destination path.
    if (process.argv.length != 3) {
        process.stderr.write(`Expected exactly one argument (destination), got ${process.argv.length - 2}.`);
        process.exit(2);
    }
    const destination = path.resolve(process.argv[2]);

    const request = await retrieveRequestFromStdin<InRequest>();

    const headers = createFetchHeaders(request);

    // Fetch metadata
    const chartResp = await fetch(`${request.source.server_url}/${request.source.chart_name}/${request.version.version}`, { headers: headers });
    const chartJson = await chartResp.json();

    if (request.source.harbor_api === true) {
        // Read params and pre-initialize them with documented default values.
        let targetBasename: string = `${chartJson.metadata.name}-${chartJson.metadata.version}`;
        if (request.params != null) {
            if (request.params.target_basename != null) {
                targetBasename = request.params.target_basename;
            }
        }

        const response: InResponse = {
            version: {
                version: chartJson.metadata.version,
                digest: chartJson.metadata.digest
            },
            metadata: [
                { name: "created", value: chartJson.metadata.created },
                { name: "description", value: chartJson.metadata.description }
            ]
        }

        var non_api_server_url = request.source.server_url.replace("api/","")

        const tgzResp = await fetch(`${non_api_server_url}/${request.source.chart_name}-${chartJson.metadata.version}.tgz`, { headers: headers });
        await writeFile(path.resolve(destination, `${targetBasename}.tgz`), await tgzResp.buffer());

        const provResp = await fetch(`${non_api_server_url}/${request.source.chart_name}-${chartJson.metadata.version}.tgz.prov`, { headers: headers });
        await writeFile(path.resolve(destination, `${targetBasename}.tgz.prov`), await provResp.buffer());

        await writeFile(path.resolve(destination, `${targetBasename}.json`), JSON.stringify(chartJson));
        process.stdout.write(JSON.stringify(response, null, 2));
    } else {
        // Read params and pre-initialize them with documented default values.
        let targetBasename: string = `${chartJson.name}-${chartJson.version}`;
        if (request.params != null) {
            if (request.params.target_basename != null) {
                targetBasename = request.params.target_basename;
            }
        }

        const response: InResponse = {
            version: {
                version: chartJson.version,
                digest: chartJson.digest
            },
            metadata: [
                { name: "created", value: chartJson.created },
                { name: "description", value: chartJson.description },
                { name: "appVersion", value: chartJson.appVersion },
                { name: "home", value: chartJson.home },
                { name: "tillerVersion", value: chartJson.tillerVersion }
            ]
        }

        var non_api_server_url = request.source.server_url.replace("api/","")

        const tgzResp = await fetch(`${non_api_server_url}/${request.source.chart_name}-${chartJson.version}.tgz`, { headers: headers });
        await writeFile(path.resolve(destination, `${targetBasename}.tgz`), await tgzResp.buffer());

        const provResp = await fetch(`${non_api_server_url}/${request.source.chart_name}-${chartJson.version}.tgz.prov`, { headers: headers });
        await writeFile(path.resolve(destination, `${targetBasename}.tgz.prov`), await provResp.buffer());

        await writeFile(path.resolve(destination, `${targetBasename}.json`), JSON.stringify(chartJson));
        process.stdout.write(JSON.stringify(response, null, 2));
    }

})();
