import { expect, it } from "vitest";
import { authenticateOpenAIModel } from "../../src/llm/live-authorization.js";

it("authenticates only the fixed official read-only model endpoint with no credential output or redirect", async () => {
  const seen: Array<{url:string;init:RequestInit|undefined}> = [];
  const fetcher: typeof fetch = (url,init) => { seen.push({url:typeof url === "string" ? url : url instanceof URL ? url.href : url.url,init}); return Promise.resolve(new Response(JSON.stringify({id:"fixture-model"}),{status:200})); };
  expect(await authenticateOpenAIModel("fixture-model",{OPENAI_API_KEY:"fixture-secret"},fetcher)).toEqual({model:"fixture-model",httpStatus:200});
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("https://api.openai.com/v1/models/fixture-model");
  expect(seen[0]?.init?.redirect).toBe("error");
  expect(new Headers(seen[0]?.init?.headers).get("Authorization")).toBe("Bearer fixture-secret");
});
it("rejects missing keys, invalid model IDs, mismatched responses, and auth failures without retry", async () => {
  let calls=0;
  const denied: typeof fetch = () => { calls+=1; return Promise.resolve(new Response("private provider diagnostic",{status:401})); };
  await expect(authenticateOpenAIModel("model",{},denied)).rejects.toThrow(/OPENAI_API_KEY/);
  await expect(authenticateOpenAIModel("https://other.example",{OPENAI_API_KEY:"fixture"},denied)).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(authenticateOpenAIModel("model",{OPENAI_API_KEY:"fixture"},denied)).rejects.toThrow("Model authentication failed with HTTP 401");
  expect(calls).toBe(1);
  await expect(authenticateOpenAIModel("model",{OPENAI_API_KEY:"fixture"},()=>Promise.resolve(new Response('{"id":"another-model"}')))).rejects.toThrow(/identity/);
});
