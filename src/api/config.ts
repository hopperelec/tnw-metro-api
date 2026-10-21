export const PORT = +Bun.env.PORT || 3000;

export const HOST = Bun.env.HOST || 'localhost';

/** The URL which the API is publicly available at, without a trailing slash, for links in the docs and headers */
export const PUBLIC_URL = (Bun.env.PUBLIC_URL || `http://${HOST}:${PORT}`).replace(/\/$/, '');
