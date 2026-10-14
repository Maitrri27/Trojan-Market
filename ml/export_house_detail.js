#!/usr/bin/env node
/* Export the static housing attribute table for the Python pipeline.
   Run:  node ml/export_house_detail.js  */
const fs = require('fs');
const path = require('path');
const { HOUSE } = require('../server/data');

const out = path.join(__dirname, 'artifacts', 'house_detail.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(HOUSE, null, 2));
console.log('Wrote ' + Object.keys(HOUSE).length + ' housing records -> ' + out);
