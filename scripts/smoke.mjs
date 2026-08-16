const base = process.env.NERDDING_API_URL ?? "http://localhost:4000/api/v1";
const stamp = Date.now();
const email = `smoke-${stamp}@example.com`;
const username = `smoke${stamp}`;

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) } });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(`${path} ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const registered = await request("/auth/register", { method: "POST", body: JSON.stringify({ name: "Smoke Tester", username, email, password: "ChangeMe123!", accountType: "user" }) });
const token = registered.data.token;
const headers = { Authorization: `Bearer ${token}` };
const post = await request("/posts", { method: "POST", headers, body: JSON.stringify({ body: "Smoke test post", topic: "build", media: [] }) });
await request(`/posts/${post.data.id}/like`, { method: "POST", headers, body: "{}" });
await request(`/posts/${post.data.id}/comments`, { method: "POST", headers, body: JSON.stringify({ body: "Thoughtful smoke test comment" }) });
await request("/settings/profile", { method: "PATCH", headers, body: JSON.stringify({ bio: "Updated by smoke test" }) });
await request("/messages", { method: "POST", headers, body: JSON.stringify({ recipientId: "rahul", body: "Hello from the smoke test" }) });
console.log(JSON.stringify({ ok: true, user: registered.data.user.username, post: post.data.id }));
