// What the two gateways in ./worker.mjs do with a request from the app.
// Kept apart from the Worker so the tests can run it in Node (see
// src/lib/cloudflare-gateways.test.ts).
//
// Both gateways take the same token, made once for each install and given
// to the app when its container starts. Being inside the container is not
// enough: a request the app is tricked into making to one of the gateway
// names carries no token, and is refused.

// The app's S3 driver puts a bucket name first in every path. There is one
// bucket, the one bound to the Worker, so the name is only a placeholder.
export const BUCKET_PLACEHOLDER = "documents";

function sameText(left, right) {
  let difference = left.length ^ right.length;

  // Compares every character, so the time taken does not show how much of
  // a guess was right.
  for (let index = 0; index < left.length; index++) {
    difference |=
      left.charCodeAt(index) ^ right.charCodeAt(index % right.length);
  }

  return difference === 0;
}

function holdsToken(presented, token) {
  return (
    typeof token === "string" &&
    token.length > 0 &&
    typeof presented === "string" &&
    presented.length > 0 &&
    sameText(presented, token)
  );
}

/**
 * The token in a request from the app's S3 driver. The driver signs each
 * request and names its access key id in the Authorization header (see
 * src/lib/services/storage/s3.ts). The Worker gives the app the token as
 * that id.
 */
function storageToken(request) {
  return /^AWS4-HMAC-SHA256 Credential=([^/,\s]+)\//.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
}

/** The token in a request from the app's email driver: a bearer token. */
function emailToken(request) {
  return /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
}

/**
 * The app's document storage, on an R2 bucket. It answers the four S3-style
 * calls the app's storage driver makes: GET, HEAD, PUT and DELETE of one
 * object.
 */
export async function serveStorage(request, bucket, token) {
  if (!holdsToken(storageToken(request), token)) {
    return new Response("AccessDenied", { status: 403 });
  }

  const path = decodeURIComponent(new URL(request.url).pathname);
  const prefix = `/${BUCKET_PLACEHOLDER}/`;

  if (!path.startsWith(prefix) || path.length === prefix.length) {
    return new Response("InvalidRequest", { status: 400 });
  }

  const key = path.slice(prefix.length);

  switch (request.method) {
    case "GET":
    case "HEAD": {
      const object =
        request.method === "GET"
          ? await bucket.get(key)
          : await bucket.head(key);

      if (!object) {
        return new Response(request.method === "GET" ? "NoSuchKey" : null, {
          status: 404,
        });
      }

      const headers = new Headers({
        "content-length": String(object.size),
        etag: object.httpEtag,
      });

      if (object.httpMetadata?.contentType) {
        headers.set("content-type", object.httpMetadata.contentType);
      }

      return new Response(request.method === "GET" ? object.body : null, {
        headers,
      });
    }
    case "PUT": {
      // "If-None-Match: *" asks R2 to keep an object that is already
      // there. R2 then stores nothing and answers null.
      const stored = await bucket.put(key, await request.arrayBuffer(), {
        httpMetadata: {
          contentType: request.headers.get("content-type") ?? undefined,
        },
        onlyIf:
          request.headers.get("if-none-match") === "*"
            ? new Headers({ "if-none-match": "*" })
            : undefined,
      });

      return stored
        ? new Response(null, { headers: { etag: stored.httpEtag } })
        : new Response("PreconditionFailed", { status: 412 });
    }
    case "DELETE":
      await bucket.delete(key);

      return new Response(null, { status: 204 });
    default:
      return new Response("MethodNotAllowed", { status: 405 });
  }
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function errorAnswer(status, message) {
  return Response.json(
    { errors: [{ message }], result: null, success: false },
    { status },
  );
}

/**
 * The app's outgoing email, on an email binding. It takes the request the
 * app's Cloudflare email driver makes (the shape of the Email Service REST
 * API, see src/lib/services/email-cloudflare.ts) and answers in the same
 * shape.
 */
export async function sendEmail(request, email, token) {
  if (!holdsToken(emailToken(request), token)) {
    return errorAnswer(403, "Authentication error.");
  }

  if (request.method !== "POST") {
    return errorAnswer(405, "Method not allowed.");
  }

  const message = await request.json().catch(() => null);

  if (!message || typeof message !== "object") {
    return errorAnswer(400, "Invalid email request.");
  }

  try {
    await email.send({
      ...(message.attachments?.length
        ? {
            attachments: message.attachments.map((attachment) => ({
              content: fromBase64(attachment.content),
              disposition: attachment.disposition ?? "attachment",
              filename: attachment.filename,
              type: attachment.type,
            })),
          }
        : {}),
      from:
        typeof message.from === "string"
          ? message.from
          : { email: message.from.address, name: message.from.name },
      ...(message.html ? { html: message.html } : {}),
      ...(message.reply_to ? { replyTo: message.reply_to } : {}),
      subject: message.subject,
      text: message.text,
      to: message.to,
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const code = error?.code ?? "";

    // The driver tries again after a 429 or a 5xx, and gives up on
    // anything else. Only a rate limit is worth another try.
    return errorAnswer(code === "E_RATE_LIMIT_EXCEEDED" ? 429 : 400, text);
  }

  return Response.json({
    errors: [],
    result: {
      delivered: [],
      permanent_bounces: [],
      queued: [message.to].flat(),
    },
    success: true,
  });
}
