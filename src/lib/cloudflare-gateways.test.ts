import assert from "node:assert/strict";
import { test } from "node:test";

import { sendEmail, serveStorage } from "../../cloudflare/gateways.mjs";
import { createS3StorageService } from "./services/storage/s3.ts";

// The two gateways in cloudflare/worker.mjs hold every document and can
// send email as the organization. They answer at names that only the app's
// container can reach, which is not enough by itself: a request the app is
// tricked into making to one of those names comes from inside too. So each
// gateway asks for the install's token, and these tests fail if one stops.

const TOKEN = "the-token-of-this-install";
const STORAGE_URL = "http://storage.signudoc.internal/documents/a/doc.pdf";
const EMAIL_URL = "http://email.signudoc.internal/send";

// A stand-in for an R2 bucket, with the four calls the gateway makes.
function createFakeBucket() {
  const objects = new Map<string, Uint8Array>();
  const describe = (body: Uint8Array) => ({
    body,
    httpEtag: '"etag"',
    httpMetadata: { contentType: "application/pdf" },
    size: body.byteLength,
  });

  return {
    bucket: {
      async delete(key: string) {
        objects.delete(key);
      },
      async get(key: string) {
        const body = objects.get(key);

        return body ? describe(body) : null;
      },
      async head(key: string) {
        const body = objects.get(key);

        return body ? describe(body) : null;
      },
      async put(key: string, body: ArrayBuffer) {
        objects.set(key, new Uint8Array(body));

        return { httpEtag: '"etag"' };
      },
    },
    objects,
  };
}

// A stand-in for the Worker's email binding that records what it sent.
function createFakeEmail() {
  const sent: unknown[] = [];

  return {
    email: {
      async send(message: unknown) {
        sent.push(message);
      },
    },
    sent,
  };
}

function emailRequest(headers: Record<string, string>) {
  return new Request(EMAIL_URL, {
    body: JSON.stringify({
      from: { address: "sign@acme.example", name: "Acme" },
      subject: "Please sign",
      text: "Please sign.",
      to: "signer@example.com",
    }),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

const signedAs = (accessKeyId: string) => ({
  authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260101/auto/s3/aws4_request, SignedHeaders=host, Signature=0`,
});

test("storage refuses a request that carries no token", async () => {
  const { bucket, objects } = createFakeBucket();

  objects.set("a/doc.pdf", new Uint8Array([1, 2, 3]));

  for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
    const response = await serveStorage(
      new Request(STORAGE_URL, {
        body: method === "PUT" ? new Uint8Array([9]) : undefined,
        method,
      }),
      bucket,
      TOKEN,
    );

    assert.equal(response.status, 403, method);
  }

  // Nothing was read, replaced or removed.
  assert.deepEqual([...objects.get("a/doc.pdf")!], [1, 2, 3]);
});

test("storage refuses a wrong token, and any token when it has none itself", async () => {
  const { bucket, objects } = createFakeBucket();

  objects.set("a/doc.pdf", new Uint8Array([1, 2, 3]));

  const attempts: Array<[Record<string, string>, string | undefined]> = [
    [signedAs("a-guess"), TOKEN],
    [signedAs(`${TOKEN}x`), TOKEN],
    [signedAs(TOKEN.slice(0, -1)), TOKEN],
    [{ authorization: `Bearer ${TOKEN}` }, TOKEN],
    [{ authorization: `Basic ${btoa(`${TOKEN}:`)}` }, TOKEN],
    [signedAs(TOKEN), undefined],
    [signedAs(TOKEN), ""],
    [signedAs("undefined"), undefined],
  ];

  for (const [headers, token] of attempts) {
    const response = await serveStorage(
      new Request(STORAGE_URL, { headers }),
      bucket,
      token,
    );

    assert.equal(response.status, 403, JSON.stringify(headers));
  }
});

test("the app's storage driver gets through with the token, and not without it", async () => {
  const { bucket, objects } = createFakeBucket();
  const driver = (accessKeyId: string) =>
    createS3StorageService({
      env: {
        S3_ACCESS_KEY_ID: accessKeyId,
        S3_BUCKET: "documents",
        S3_ENDPOINT: "http://storage.signudoc.internal",
        S3_SECRET_ACCESS_KEY: accessKeyId,
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
        serveStorage(new Request(input, init), bucket, TOKEN)) as typeof fetch,
    });

  await driver(TOKEN).putObject({
    body: new Uint8Array([4, 5, 6]),
    contentType: "application/pdf",
    key: "a/doc.pdf",
  });
  assert.deepEqual([...objects.get("a/doc.pdf")!], [4, 5, 6]);
  assert.deepEqual(
    [...(await driver(TOKEN).getObject("a/doc.pdf")).body],
    [4, 5, 6],
  );
  assert.equal((await driver(TOKEN).headObject("a/doc.pdf")).exists, true);

  await assert.rejects(driver("another-install").getObject("a/doc.pdf"), /403/);
  await assert.rejects(driver("another-install").deleteObject("a/doc.pdf"));
  assert.equal(objects.has("a/doc.pdf"), true);

  await driver(TOKEN).deleteObject("a/doc.pdf");
  assert.equal(objects.has("a/doc.pdf"), false);
});

test("email refuses a request without the token and sends nothing", async () => {
  const { email, sent } = createFakeEmail();

  const attempts: Array<[Record<string, string>, string | undefined]> = [
    [{}, TOKEN],
    [{ authorization: "Bearer a-guess" }, TOKEN],
    [{ authorization: `Bearer ${TOKEN}x` }, TOKEN],
    [signedAs(TOKEN), TOKEN],
    [{ authorization: `Bearer ${TOKEN}` }, undefined],
    [{ authorization: `Bearer ${TOKEN}` }, ""],
    [{ authorization: "Bearer undefined" }, undefined],
  ];

  for (const [headers, token] of attempts) {
    const response = await sendEmail(emailRequest(headers), email, token);

    assert.equal(response.status, 403, JSON.stringify(headers));
  }

  assert.equal(sent.length, 0);
});

test("email sends for a request that carries the token", async () => {
  const { email, sent } = createFakeEmail();
  const response = await sendEmail(
    emailRequest({ authorization: `Bearer ${TOKEN}` }),
    email,
    TOKEN,
  );

  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
});
