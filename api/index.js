'use strict';

// Vercel serverless entry — exports the same Express app that `npm start`
// runs locally. All routes (including the static frontend in public/) are
// served through this function; see vercel.json.
module.exports = require('../server');
