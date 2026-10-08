// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// UNKNOWN is represented by null, never by a deployable example identity.
// Actual registration metadata and a newly reviewed helper commit must precede
// a separately qualified activation. Environment/artifact input cannot fill this.
const authority = require('./kimi-publication-authority.cjs');
const publicationRuntime = Object.freeze({ sha: null, reviewSHA256: null,
  authSHA256: null, authoritySHA256: null });
module.exports = Object.freeze({ authority, publicationRuntime });
