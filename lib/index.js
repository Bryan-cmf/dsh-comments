/**
 * dsh-markup — host half.
 *
 * Markup is entirely a browser feature: selection watching, mark storage
 * (localStorage), highlighting, and composer hand-off all live in the client
 * half, so this row injects nothing and exposes no Service. It exists because
 * `dsh-client-modules` discovers browser bundles by scanning ACTIVE Loader
 * entries — an entry whose package declares `dsh.client` is what puts
 * `lib/client.js` into `window.__DSH_BOOT__` and behind `/plugins/<id>/client.js`.
 */

/** Loader entry / diagnostic name. */
export const name = 'markup'

/** No host Service is read, so injection would only delay activation. */
export const inject = []

/** Inert host half: the browser bundle carries the whole feature. */
export function apply() {}
