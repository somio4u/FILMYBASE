// Runs the local imitation of Google (sign-in page, tokens, Drive) on a fixed
// port, for trying the app end to end without real Google. Dev/testing only.
//   node tests/mockGoogleServer.mjs 4500
import { startMockDrive } from "./mockDrive.js";
const port = Number(process.argv[2] ?? 4500);
const mock = await startMockDrive({ port });
console.log(`Mock Google on http://127.0.0.1:${mock.port}`);
