'use strict';
// RED: protocol delegation is not implemented.
async function schema() { throw new Error('typed-kimi:not-implemented'); }
async function publicationIntent() { throw new Error('typed-kimi:not-implemented'); }
module.exports = { schema, publicationIntent };
