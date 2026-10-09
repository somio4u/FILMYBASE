// Runs the local imitation of Google's picture/voice/video service on a fixed
// port, for trying the app end to end without paying for real AI. Dev/testing only.
//   node tests/mockGeminiServer.mjs 4600     then start the backend with
//   GEMINI_API_KEY=test-key GEMINI_API_BASE=http://127.0.0.1:4600
import { startMockGemini } from "./mockGemini.js";
const mock = await startMockGemini({ port: Number(process.argv[2] ?? 4600) });
mock.state.videoPollsBeforeDone = 1;
console.log(`Mock Gemini on ${mock.base}`);
