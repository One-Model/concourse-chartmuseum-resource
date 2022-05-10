import { Headers } from "node-fetch";
import { Agent, AgentOptions } from "https";

export async function retrieveRequestFromStdin<T extends any>(): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let inputRaw = "";
        process.stdin.on("data", (chunk) => inputRaw += chunk);
        process.stdin.on("end", async () => {
            try {
                const json = JSON.parse(inputRaw) as T;
                resolve(json);
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function createFetchAgent<R extends CheckRequest>(request: R): Agent {
    let options: AgentOptions = {
        keepAlive: false
    };

    if (request.source.tls_ca_cert != null) {
        options.ca = request.source.tls_ca_cert;
    }

    if (request.source.tls_client_cert != null && request.source.tls_client_key != null) {
        options.cert = request.source.tls_client_cert;
        options.key = request.source.tls_client_key;
    }

    return new Agent(options);
}

export function createFetchHeaders<R extends CheckRequest>(request: R): Headers {
    const headers = new Headers();
    if (request.source.basic_auth_username && request.source.basic_auth_password) {
        const basicAuthUsername = request.source.basic_auth_username;
        const basicAuthPassword = request.source.basic_auth_password;
        headers.append("Authorization", `Basic ${new Buffer(basicAuthUsername + ":" + basicAuthPassword).toString("base64")}`);
    }
    return headers;
}

export interface Repository {
    server_url: string
    basic_auth_username?: string
    basic_auth_password?: string
    tls_ca_cert?: string
    tls_client_cert?: string
    tls_client_key?: string
}

interface Request {
    source: Source
}

export interface Source extends Repository {
    chart_name: string
    version_range?: string
    harbor_api?: boolean
}

export interface CheckRequest extends Request {
    version?: {
        version: string
        digest: string
    }
}

export type CheckResponse = {
    version: string
    digest: string
}[];

export interface InRequest extends CheckRequest {
    version: {
        version: string,
        digest: string
    },
    params: {
        target_basename?: string
    }
}

export interface InResponse {
    version: {
        version: string
        digest: string
    }
    metadata: {
        name: string
        value: string
    }[]
}

export interface OutRequest extends Request {
    params: {
        chart: string
        sign?: boolean
        key_data?: string
        key_file?: string
        key_passphrase?: string
        version?: string
        version_file?: string
        force?: boolean
        dependency_update?: boolean
        dependency_repos?: {[name: string]: Repository}
    }
}

export interface OutResponse extends InResponse {
}
