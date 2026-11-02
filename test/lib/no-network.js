// Suites labelled "no Spotify requests" send nothing off this Mac: no Spotify
// (the player library would connect with the test's fake token), no fonts, no
// DRM component download. Required first, before anything can connect. Suites'
// own fakes sit in front of this; whatever they don't answer stops here.
const { app, shell } = require('electron'); const dns = require('dns');
const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i;
// Everything Chromium does: pages, the player library, sockets, net.fetch.
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
// Everything Node does: fetch and http(s) in the main process.
const realFetch = global.fetch;
global.fetch = (url, options) => {
  const { hostname } = new URL(typeof url === 'object' && url.url ? url.url : String(url));
  return LOCAL.test(hostname) ? realFetch(url, options) : Promise.reject(new TypeError('no-network: blocked ' + hostname));
};
const realLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  if (LOCAL.test(hostname)) return realLookup(hostname, options, callback);
  (callback || options)(Object.assign(new Error('no-network: blocked ' + hostname), { code: 'ENOTFOUND' }));
};
// The real browser, which would go to Spotify on its own. Suites that check the link replace this.
shell.openExternal = async (url) => { console.log('no-network: did not open ' + url); };
