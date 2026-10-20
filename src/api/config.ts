// These are functions rather than constants, since modules are evaluated before `.env` is loaded

export function getPort(): number {
    return +process.env.PORT || 3000;
}

export function getHost(): string {
    return process.env.HOST || 'localhost';
}

/** The URL which the API is publicly available at, without a trailing slash, for links in the docs and headers */
export function getPublicUrl(): string {
    return (process.env.PUBLIC_URL || `http://${getHost()}:${getPort()}`).replace(/\/$/, '');
}
