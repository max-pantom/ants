// Run the scripted model on its own, for poking at the UI without a key: npx tsx test/run-mock.ts
import { startMockModel } from "./mock-model.ts";
const port = Number(process.env.PORT ?? 4999);
await startMockModel(port);
console.log(`mock model on http://127.0.0.1:${port}/v1`);
