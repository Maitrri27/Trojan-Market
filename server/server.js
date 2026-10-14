/* Entry point moved to server/index.js in the modular refactor.
   Kept as a shim so existing `node server/server.js` invocations still work. */
module.exports = require('./index');
