import { buildLocalViewer } from '../src/backup/localViewer.js';
const [destination, ...sourceIds] = process.argv.slice(2);
if (!destination || !sourceIds.length) throw new Error('Usage: node ops/build-backup-viewer.mjs DESTINATION SOURCE_ID...');
console.log(JSON.stringify(await buildLocalViewer({ destination, sourceIds })));
