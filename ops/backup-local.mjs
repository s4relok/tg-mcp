import fs from 'node:fs/promises';
import { missingReplicaFiles, receiveReplica } from '../src/backup/localReplica.js';
const [command, destination, manifestFile, payload, jobId] = process.argv.slice(2);
const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
if (command === 'plan') console.log(JSON.stringify(await missingReplicaFiles(destination, manifest)));
else if (command === 'receive') console.log(JSON.stringify(await receiveReplica({ destination, manifest, packageFile: payload, jobId })));
else throw new Error('Use plan or receive');
