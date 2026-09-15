import assert from "node:assert/strict";
import test from "node:test";
import { configuredApiOrigin, requestIdentity } from "../src/security.js";

test("MCP upstream accepts only an HTTPS origin or loopback development origin", () => {
  assert.equal(configuredApiOrigin("https://chusky.example/"), "https://chusky.example");
  assert.equal(configuredApiOrigin("http://localhost:8080"), "http://localhost:8080");
  assert.equal(configuredApiOrigin("http://chusky.example"), undefined);
  assert.equal(configuredApiOrigin("https://user:pass@chusky.example"), undefined);
  assert.equal(configuredApiOrigin("https://chusky.example/path"), undefined);
});

test("MCP identity requires a scoped project key and bounded non-control user ID", () => {
  const request = (key: string, userId: string) => ({
    headers: { get: (name: string) => name.toLowerCase() === "authorization" ? `Bearer ${key}` : userId },
  }) as unknown as Request;
  assert.deepEqual(requestIdentity(request(`chsk_${"a".repeat(32)}`, "tenant-user-42")), { apiKey: `chsk_${"a".repeat(32)}`, userId: "tenant-user-42" });
  assert.equal(requestIdentity(request("root-secret-value-that-must-not-work", "tenant-user-42")), undefined);
  assert.equal(requestIdentity(request(`chsk_${"a".repeat(32)}`, "bad\nidentity")), undefined);
  assert.equal(requestIdentity(request(`chsk_${"a".repeat(32)}`, "")), undefined);
});
