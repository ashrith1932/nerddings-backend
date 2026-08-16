import type { Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import jwt from "jsonwebtoken";
import { and, eq, or } from "drizzle-orm";

import { env } from "../config/env.js";
import { db } from "../db/client.js";

import {
  conversationMembers,
  conversations,
  messageRequests,
  messages,
} from "../db/schema.js";

const require = createRequire(import.meta.url);

type RawData =
  | Buffer
  | ArrayBuffer
  | Buffer[];

type WebSocketLike = {
  readonly readyState: number;

  send(data: string): void;

  close(
    code?: number,
    reason?: string,
  ): void;

  on(
    event: "message",
    listener: (
      raw: RawData,
    ) => void | Promise<void>,
  ): void;

  on(
    event: "close",
    listener: () => void,
  ): void;

  on(
    event: "error",
    listener: (
      error: Error,
    ) => void,
  ): void;
};

type WebSocketServerLike = {
  on(
    event: "connection",
    listener: (
      socket: WebSocketLike,
    ) => void,
  ): void;
};

const {
  WebSocketServer,
  WebSocket,
} = require("ws") as {
  WebSocketServer: new (options: {
    server: HttpServer;
    path?: string;
  }) => WebSocketServerLike;

  WebSocket: {
    OPEN: number;
  };
};

type AuthPayload = {
  sub?: string;
  accountType?: "user" | "agent";
};

type ClientMessage =
  | {
      type: "auth";
      token: string;
    }

  | {
      type: "message.send";

      clientMessageId: string;

      recipientId: string;

      ciphertext: string;
      iv: string;

      senderKey: string;
      recipientKey: string;

      encryptionVersion: number;
    }

  | {
      type: "message.delivered";

      messageId: string;
    }

  | {
      type: "message.read";

      messageId: string;
    }

  | {
      type: "conversation.read";

      conversationId: string;
    }

  | {
      type: "ping";
    };

const clients = new Map<
  string,
  Set<WebSocketLike>
>();

function send(
  socket: WebSocketLike,
  payload: unknown,
) {
  if (
    socket.readyState ===
    WebSocket.OPEN
  ) {
    socket.send(
      JSON.stringify(payload),
    );
  }
}

function addClient(
  userId: string,
  socket: WebSocketLike,
) {
  let sockets =
    clients.get(userId);

  if (!sockets) {
    sockets =
      new Set<WebSocketLike>();

    clients.set(
      userId,
      sockets,
    );
  }

  sockets.add(socket);
}

function removeClient(
  userId: string,
  socket: WebSocketLike,
) {
  const sockets =
    clients.get(userId);

  if (!sockets) {
    return;
  }

  sockets.delete(socket);

  if (sockets.size === 0) {
    clients.delete(userId);
  }
}

function sendToUser(
  userId: string,
  payload: unknown,
) {
  const sockets =
    clients.get(userId);

  if (!sockets) {
    return;
  }

  for (const socket of sockets) {
    send(socket, payload);
  }
}

/*
 * Find a conversation between two users.
 */
async function findConversation(
  userA: string,
  userB: string,
) {
  if (!db) {
    return null;
  }

  const memberships =
    await db
      .select({
        conversationId:
          conversationMembers.conversationId,
      })
      .from(
        conversationMembers,
      )
      .where(
        eq(
          conversationMembers.userId,
          userA,
        ),
      );

  for (
    const membership of memberships
  ) {
    const [match] =
      await db
        .select({
          conversationId:
            conversationMembers.conversationId,
        })
        .from(
          conversationMembers,
        )
        .where(
          and(
            eq(
              conversationMembers.conversationId,
              membership.conversationId,
            ),

            eq(
              conversationMembers.userId,
              userB,
            ),
          ),
        )
        .limit(1);

    if (match) {
      return match.conversationId;
    }
  }

  return null;
}

/*
 * Create conversation.
 */
async function createConversation(
  userA: string,
  userB: string,
) {
  if (!db) {
    throw new Error(
      "Database is required for realtime messaging.",
    );
  }

  const conversationId =
    randomUUID();

  await db
    .insert(conversations)
    .values({
      id: conversationId,
    });

  await db
    .insert(
      conversationMembers,
    )
    .values([
      {
        conversationId,
        userId: userA,
      },
      {
        conversationId,
        userId: userB,
      },
    ]);

  return conversationId;
}

/*
 * Check whether messaging is allowed.
 */
async function canMessage(
  userA: string,
  userB: string,
) {
  if (!db) {
    return false;
  }

  const [request] =
    await db
      .select()
      .from(
        messageRequests,
      )
      .where(
        and(
          or(
            and(
              eq(
                messageRequests.senderId,
                userA,
              ),

              eq(
                messageRequests.recipientId,
                userB,
              ),
            ),

            and(
              eq(
                messageRequests.senderId,
                userB,
              ),

              eq(
                messageRequests.recipientId,
                userA,
              ),
            ),
          ),

          eq(
            messageRequests.status,
            "accepted",
          ),
        ),
      )
      .limit(1);

  return Boolean(request);
}

/*
 * JWT authentication.
 */
function authenticate(
  token: string,
) {
  try {
    const payload =
      jwt.verify(
        token,
        env.AUTH_SECRET,
      ) as AuthPayload;

    if (
      !payload.sub ||
      (
        payload.accountType !==
          "user" &&
        payload.accountType !==
          "agent"
      )
    ) {
      return null;
    }

    return {
      userId: payload.sub,
      accountType:
        payload.accountType,
    };
  } catch {
    return null;
  }
}

/*
 * Get the other participant.
 */
async function getOtherParticipant(
  conversationId: string,
  senderId: string,
) {
  if (!db) {
    return null;
  }

  const [member] =
    await db
      .select({
        userId:
          conversationMembers.userId,
      })
      .from(
        conversationMembers,
      )
      .where(
        and(
          eq(
            conversationMembers.conversationId,
            conversationId,
          ),

          // We want the other user.
        ),
      );

  const members =
    await db
      .select({
        userId:
          conversationMembers.userId,
      })
      .from(
        conversationMembers,
      )
      .where(
        eq(
          conversationMembers.conversationId,
          conversationId,
        ),
      );

  const other =
    members.find(
      (member) =>
        member.userId !==
        senderId,
    );

  return other?.userId ?? null;
}

/*
 * Build the message sent to clients.
 */
function serializeMessage(
  message: typeof messages.$inferSelect,
) {
  return {
    id: message.id,

    conversationId:
      message.conversationId,

    senderId:
      message.senderId,

    ciphertext:
      message.ciphertext,

    iv:
      message.iv,

    senderKey:
      message.senderKey,

    recipientKey:
      message.recipientKey,

    encryptionVersion:
      message.encryptionVersion,

    deliveredAt:
      message.deliveredAt
        ? message.deliveredAt.toISOString()
        : null,

    readAt:
      message.readAt
        ? message.readAt.toISOString()
        : null,

    createdAt:
      message.createdAt.toISOString(),
  };
}

export function attachRealtimeServer(
  server: HttpServer,
) {
  const wss =
    new WebSocketServer({
      server,

      path:
        "/api/v1/messages/ws",
    });

  wss.on(
    "connection",
    (
      socket: WebSocketLike,
    ) => {
      let authenticatedUserId:
        | string
        | null = null;

      socket.on(
        "message",
        async (
          raw: RawData,
        ) => {
          try {
            const message =
              JSON.parse(
                raw.toString(),
              ) as ClientMessage;

            /*
             * ---------------------------
             * PING
             * ---------------------------
             */
            if (
              message.type ===
              "ping"
            ) {
              send(socket, {
                type: "pong",
                timestamp:
                  Date.now(),
              });

              return;
            }

            /*
             * ---------------------------
             * AUTH
             * ---------------------------
             */
            if (
              message.type ===
              "auth"
            ) {
              const auth =
                authenticate(
                  message.token,
                );

              if (!auth) {
                send(socket, {
                  type:
                    "auth.error",

                  error:
                    "Invalid authentication token.",
                });

                socket.close(
                  1008,
                  "Unauthorized",
                );

                return;
              }

              authenticatedUserId =
                auth.userId;

              addClient(
                auth.userId,
                socket,
              );

              send(socket, {
                type:
                  "auth.success",

                userId:
                  auth.userId,
              });

              console.log(
                `[WS] User ${auth.userId} connected`,
              );

              return;
            }

            /*
             * Everything below requires auth.
             */
            if (
              !authenticatedUserId
            ) {
              send(socket, {
                type: "error",

                error:
                  "Authenticate the WebSocket first.",
              });

              return;
            }

            /*
             * ---------------------------
             * SEND MESSAGE
             * ---------------------------
             */
            if (
              message.type ===
              "message.send"
            ) {
              if (!db) {
                send(socket, {
                  type:
                    "message.failed",

                  clientMessageId:
                    message.clientMessageId,

                  error:
                    "Database is unavailable.",
                });

                return;
              }

              const allowed =
                await canMessage(
                  authenticatedUserId,
                  message.recipientId,
                );

              if (!allowed) {
                send(socket, {
                  type:
                    "message.failed",

                  clientMessageId:
                    message.clientMessageId,

                  error:
                    "Messaging is not accepted.",
                });

                return;
              }

              const conversationId =
                (await findConversation(
                  authenticatedUserId,
                  message.recipientId,
                )) ??
                (await createConversation(
                  authenticatedUserId,
                  message.recipientId,
                ));

              const [created] =
                await db
                  .insert(messages)
                  .values({
                    conversationId,

                    senderId:
                      authenticatedUserId,

                    body: "",

                    ciphertext:
                      message.ciphertext,

                    iv:
                      message.iv,

                    senderKey:
                      message.senderKey,

                    recipientKey:
                      message.recipientKey,

                    encryptionVersion:
                      message.encryptionVersion,
                  })
                  .returning();

              await db
                .update(
                  conversations,
                )
                .set({
                  updatedAt:
                    new Date(),
                })
                .where(
                  eq(
                    conversations.id,
                    conversationId,
                  ),
                );

              const outgoing =
                serializeMessage(
                  created,
                );

              /*
               * Sender gets ACK.
               *
               * sending → sent
               */
              send(socket, {
                type:
                  "message.sent",

                clientMessageId:
                  message.clientMessageId,

                message:
                  outgoing,
              });

              /*
               * Recipient gets realtime message.
               */
              sendToUser(
                message.recipientId,
                {
                  type:
                    "message.new",

                  message:
                    outgoing,
                },
              );

              return;
            }

            /*
             * ---------------------------
             * DELIVERED
             * ---------------------------
             */
            if (
              message.type ===
              "message.delivered"
            ) {
              if (!db) {
                return;
              }

              const [stored] =
                await db
                  .select()
                  .from(messages)
                  .where(
                    eq(
                      messages.id,
                      message.messageId,
                    ),
                  )
                  .limit(1);

              if (!stored) {
                return;
              }

              /*
               * Make sure the current user
               * is actually a participant.
               */
              const [membership] =
                await db
                  .select()
                  .from(
                    conversationMembers,
                  )
                  .where(
                    and(
                      eq(
                        conversationMembers.conversationId,
                        stored.conversationId,
                      ),

                      eq(
                        conversationMembers.userId,
                        authenticatedUserId,
                      ),
                    ),
                  )
                  .limit(1);

              if (!membership) {
                return;
              }

              const deliveredAt =
                new Date();

              await db
                .update(messages)
                .set({
                  deliveredAt,
                })
                .where(
                  eq(
                    messages.id,
                    stored.id,
                  ),
                );

              /*
               * Tell original sender.
               */
              sendToUser(
                stored.senderId,
                {
                  type:
                    "message.delivered",

                  messageId:
                    stored.id,

                  deliveredAt:
                    deliveredAt.toISOString(),
                },
              );

              return;
            }

            /*
             * ---------------------------
             * READ ONE MESSAGE
             * ---------------------------
             */
            if (
              message.type ===
              "message.read"
            ) {
              if (!db) {
                return;
              }

              const [stored] =
                await db
                  .select()
                  .from(messages)
                  .where(
                    eq(
                      messages.id,
                      message.messageId,
                    ),
                  )
                  .limit(1);

              if (!stored) {
                return;
              }

              const [membership] =
                await db
                  .select()
                  .from(
                    conversationMembers,
                  )
                  .where(
                    and(
                      eq(
                        conversationMembers.conversationId,
                        stored.conversationId,
                      ),

                      eq(
                        conversationMembers.userId,
                        authenticatedUserId,
                      ),
                    ),
                  )
                  .limit(1);

              if (!membership) {
                return;
              }

              const readAt =
                new Date();

              await db
                .update(messages)
                .set({
                  deliveredAt:
                    stored.deliveredAt ??
                    readAt,

                  readAt,
                })
                .where(
                  eq(
                    messages.id,
                    stored.id,
                  ),
                );

              sendToUser(
                stored.senderId,
                {
                  type:
                    "message.read",

                  messageId:
                    stored.id,

                  readAt:
                    readAt.toISOString(),
                },
              );

              return;
            }

            /*
             * ---------------------------
             * READ ENTIRE CONVERSATION
             * ---------------------------
             */
            if (
              message.type ===
              "conversation.read"
            ) {
              if (!db) {
                return;
              }

              const [membership] =
                await db
                  .select()
                  .from(
                    conversationMembers,
                  )
                  .where(
                    and(
                      eq(
                        conversationMembers.conversationId,
                        message.conversationId,
                      ),

                      eq(
                        conversationMembers.userId,
                        authenticatedUserId,
                      ),
                    ),
                  )
                  .limit(1);

              if (!membership) {
                return;
              }

              const unread =
                await db
                  .select()
                  .from(messages)
                  .where(
                    and(
                      eq(
                        messages.conversationId,
                        message.conversationId,
                      ),

                      eq(
                        messages.readAt,
                        null,
                      ),
                    ),
                  );

              const now =
                new Date();

              for (
                const stored of unread
              ) {
                /*
                 * Don't mark our own
                 * messages as read.
                 */
                if (
                  stored.senderId ===
                  authenticatedUserId
                ) {
                  continue;
                }

                await db
                  .update(messages)
                  .set({
                    deliveredAt:
                      stored.deliveredAt ??
                      now,

                    readAt:
                      now,
                  })
                  .where(
                    eq(
                      messages.id,
                      stored.id,
                    ),
                  );

                sendToUser(
                  stored.senderId,
                  {
                    type:
                      "message.read",

                    messageId:
                      stored.id,

                    readAt:
                      now.toISOString(),
                  },
                );
              }

              return;
            }
          } catch (error) {
            console.error(
              "[WS] message error",
              error,
            );

            send(socket, {
              type: "error",

              error:
                "Invalid realtime message.",
            });
          }
        },
      );

      socket.on(
        "close",
        () => {
          if (
            authenticatedUserId
          ) {
            removeClient(
              authenticatedUserId,
              socket,
            );

            console.log(
              `[WS] User ${authenticatedUserId} disconnected`,
            );
          }
        },
      );

      socket.on(
        "error",
        (
          error: Error,
        ) => {
          console.error(
            "[WS] socket error",
            error,
          );
        },
      );
    },
  );

  console.log(
    "[WS] Realtime messaging server attached.",
  );

  return wss;
}