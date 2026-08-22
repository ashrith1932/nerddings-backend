import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";
import {
  conversationMembers,
  conversations,
  messageRequests,
  messages as dbMessages,
  notifications,
  userSettings,
  users,
  follows as followsTable,
} from "../db/schema.js";
import { and, desc, eq, ilike, or } from "drizzle-orm";

type EncryptedMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;

  ciphertext?: string | null;
  iv?: string | null;

  senderKey?: string | null;
  recipientKey?: string | null;

  encryptionVersion: number;

  deliveredAt?: string | null;
  readAt?: string | null;

  createdAt: string;
};

type MemoryConversation = {
  id: string;
  members: string[];
  messages: EncryptedMessage[];
};

type MemoryRequest = {
  id: string;
  senderId: string;
  recipientId: string;
  status: "pending" | "accepted" | "declined";
  createdAt: string;
};

const conversationsMemory = new Map<
  string,
  MemoryConversation
>();

const requestsMemory = new Map<
  string,
  MemoryRequest
>();

const keysMemory = new Map<
  string,
  {
    publicKey: string;
    version: number;
  }
>();

export const messagesRouter = Router();

/*
 * ------------------------------------------------
 * Helpers
 * ------------------------------------------------
 */

async function findConversation(
  userA: string,
  userB: string,
) {
  if (!db) {
    return (
      [...conversationsMemory.values()].find(
        (item) =>
          item.members.includes(userA) &&
          item.members.includes(userB),
      )?.id ?? null
    );
  }

  const memberships = await db
    .select({
      conversationId:
        conversationMembers.conversationId,
    })
    .from(conversationMembers)
    .where(
      eq(
        conversationMembers.userId,
        userA,
      ),
    );

  for (const membership of memberships) {
    const [other] = await db
      .select({
        conversationId:
          conversationMembers.conversationId,
      })
      .from(conversationMembers)
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

    if (other) {
      return membership.conversationId;
    }
  }

  return null;
}

async function acceptedRequest(
  userA: string,
  userB: string,
) {
  if (!db) {
    return [...requestsMemory.values()].some(
      (item) =>
        item.status === "accepted" &&
        (
          (
            item.senderId === userA &&
            item.recipientId === userB
          ) ||
          (
            item.senderId === userB &&
            item.recipientId === userA
          )
        ),
    );
  }

  const [request] = await db
    .select()
    .from(messageRequests)
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

  if (request) {
    return true;
  }

  // Check for mutual follows
  const follows = await db
    .select()
    .from(followsTable)
    .where(
      or(
        and(
          eq(followsTable.followerId, userA),
          eq(followsTable.followingId, userB)
        ),
        and(
          eq(followsTable.followerId, userB),
          eq(followsTable.followingId, userA)
        )
      )
    )
    .limit(2);

  return follows.length === 2;
}

async function createConversation(
  userA: string,
  userB: string,
) {
  if (!db) {
    const created: MemoryConversation = {
      id: randomUUID(),
      members: [userA, userB],
      messages: [],
    };

    conversationsMemory.set(
      created.id,
      created,
    );

    return created.id;
  }

  const id = randomUUID();

  await db
    .insert(conversations)
    .values({
      id,
    });

  await db
    .insert(conversationMembers)
    .values([
      {
        conversationId: id,
        userId: userA,
      },
      {
        conversationId: id,
        userId: userB,
      },
    ]);

  return id;
}

async function notify(
  recipientId: string,
  actorId: string,
  text: string,
  entityId?: string,
) {
  if (
    db &&
    recipientId !== actorId
  ) {
    await db
      .insert(notifications)
      .values({
        recipientId,
        actorId,
        kind: "message_request",
        entityId,
        text,
      });
  }
}

/*
 * Convert a database message into the
 * exact format expected by the frontend.
 *
 * IMPORTANT:
 * deliveredAt and readAt are included here
 * so message status survives page refresh.
 */
function serializeMessage(
  message: typeof dbMessages.$inferSelect,
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

/*
 * ------------------------------------------------
 * Messaging keys
 * ------------------------------------------------
 */

messagesRouter.post(
  "/keys",
  requireAuth,
  async (req, res) => {
    const parsed = z
      .object({
        publicKey: z
          .string()
          .min(20)
          .max(10000),

        version: z
          .number()
          .int()
          .positive()
          .default(1),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res
        .status(400)
        .json({
          error:
            "Messaging key is invalid.",
        });
    }

    if (db) {
      await db
        .update(users)
        .set({
          messagingPublicKey:
            parsed.data.publicKey,

          messagingKeyVersion:
            parsed.data.version,
        })
        .where(
          eq(
            users.id,
            req.auth!.subjectId,
          ),
        );
    } else {
      keysMemory.set(
        req.auth!.subjectId,
        parsed.data,
      );
    }

    return res.json({
      data: {
        saved: true,
        version:
          parsed.data.version,
      },
    });
  },
);

/*
 * ------------------------------------------------
 * Contacts
 * ------------------------------------------------
 */

messagesRouter.get(
  "/contacts",
  requireAuth,
  async (req, res) => {
    const query =
      typeof req.query.q === "string"
        ? req.query.q.trim()
        : "";

    if (!db) {
      return res.json({
        data: [],
      });
    }

    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        username: users.username,
        accountType:
          users.accountType,
        avatarUrl:
          users.avatarUrl,

        messagingPublicKey:
          users.messagingPublicKey,

        messagingKeyVersion:
          users.messagingKeyVersion,
      })
      .from(users)
      .where(
        and(
          eq(
            users.onboardingCompleted,
            true,
          ),

          query
            ? or(
                ilike(
                  users.name,
                  `%${query}%`,
                ),
                ilike(
                  users.username,
                  `%${query}%`,
                ),
              )
            : undefined,
        ),
      )
      .limit(30);

    return res.json({
      data: rows.filter(
        (item) =>
          item.id !==
          req.auth!.subjectId,
      ),
    });
  },
);

/*
 * ------------------------------------------------
 * Message requests
 * ------------------------------------------------
 */

messagesRouter.get(
  "/requests",
  requireAuth,
  async (req, res) => {
    const database = db;

    if (!database) {
      return res.json({
        data: [
          ...requestsMemory.values(),
        ].filter(
          (item) =>
            item.senderId ===
              req.auth!.subjectId ||
            item.recipientId ===
              req.auth!.subjectId,
        ),
      });
    }

    const rows = await database
      .select()
      .from(messageRequests)
      .where(
        or(
          eq(
            messageRequests.senderId,
            req.auth!.subjectId,
          ),
          eq(
            messageRequests.recipientId,
            req.auth!.subjectId,
          ),
        ),
      )
      .orderBy(
        desc(messageRequests.createdAt),
      )
      .limit(50);

    const data = await Promise.all(
      rows.map(
        async (request) => {
          const otherId =
            request.senderId ===
            req.auth!.subjectId
              ? request.recipientId
              : request.senderId;

          const [other] =
            await database
              .select({
                id: users.id,
                name: users.name,
                username:
                  users.username,
                avatarUrl:
                  users.avatarUrl,
                accountType:
                  users.accountType,

                messagingPublicKey:
                  users.messagingPublicKey,

                messagingKeyVersion:
                  users.messagingKeyVersion,
              })
              .from(users)
              .where(
                eq(
                  users.id,
                  otherId,
                ),
              )
              .limit(1);

          return {
            ...request,
            other,
          };
        },
      ),
    );

    return res.json({
      data,
    });
  },
);

messagesRouter.post(
  "/requests",
  requireAuth,
  async (req, res) => {
    const parsed = z
      .object({
        recipientId:
          z.string().uuid(),
      })
      .safeParse(req.body);

    if (
      !parsed.success ||
      parsed.data.recipientId ===
        req.auth!.subjectId
    ) {
      return res
        .status(400)
        .json({
          error:
            "Choose another member.",
        });
    }

    if (db) {
      const [recipient] =
        await db
          .select({
            id: users.id,
            allowMessages:
              userSettings.allowMessages,
          })
          .from(users)
          .leftJoin(
            userSettings,
            eq(
              userSettings.userId,
              users.id,
            ),
          )
          .where(
            eq(
              users.id,
              parsed.data.recipientId,
            ),
          )
          .limit(1);

      if (!recipient) {
        return res
          .status(404)
          .json({
            error:
              "Member not found.",
          });
      }

      if (
        recipient.allowMessages ===
        false
      ) {
        return res
          .status(403)
          .json({
            error:
              "This member is not accepting new messages.",
          });
      }

      if (
        await acceptedRequest(
          req.auth!.subjectId,
          parsed.data.recipientId,
        )
      ) {
        const conversationId =
          (await findConversation(
            req.auth!.subjectId,
            parsed.data.recipientId,
          )) ??
          (await createConversation(
            req.auth!.subjectId,
            parsed.data.recipientId,
          ));

        return res.json({
          data: {
            status: "accepted",
            conversationId,
          },
        });
      }

      const [existing] =
        await db
          .select()
          .from(messageRequests)
          .where(
            or(
              and(
                eq(
                  messageRequests.senderId,
                  req.auth!.subjectId,
                ),
                eq(
                  messageRequests.recipientId,
                  parsed.data
                    .recipientId,
                ),
                eq(
                  messageRequests.status,
                  "pending",
                ),
              ),
              and(
                eq(
                  messageRequests.senderId,
                  parsed.data
                    .recipientId,
                ),
                eq(
                  messageRequests.recipientId,
                  req.auth!.subjectId,
                ),
                eq(
                  messageRequests.status,
                  "pending",
                ),
              ),
            ),
          )
          .limit(1);

      if (existing) {
        return res.json({
          data: existing,
        });
      }

      const [created] =
        await db
          .insert(messageRequests)
          .values({
            senderId:
              req.auth!.subjectId,

            recipientId:
              parsed.data.recipientId,
          })
          .returning();

      await notify(
        parsed.data.recipientId,
        req.auth!.subjectId,
        "sent you a message request",
        created.id,
      );

      return res
        .status(201)
        .json({
          data: created,
        });
    }

    const existing = [
      ...requestsMemory.values(),
    ].find(
      (item) =>
        item.status === "pending" &&
        item.senderId ===
          req.auth!.subjectId &&
        item.recipientId ===
          parsed.data.recipientId,
    );

    if (existing) {
      return res.json({
        data: existing,
      });
    }

    const created: MemoryRequest = {
      id: randomUUID(),

      senderId:
        req.auth!.subjectId,

      recipientId:
        parsed.data.recipientId,

      status: "pending",

      createdAt:
        new Date().toISOString(),
    };

    requestsMemory.set(
      created.id,
      created,
    );

    return res
      .status(201)
      .json({
        data: created,
      });
  },
);

messagesRouter.post(
  "/requests/:requestId",
  requireAuth,
  async (req, res) => {
    const parsed = z
      .object({
        action: z.enum([
          "accept",
          "decline",
        ]),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res
        .status(400)
        .json({
          error:
            "Choose accept or decline.",
        });
    }

    const requestId =
      String(req.params.requestId);

    if (db) {
      const [request] =
        await db
          .select()
          .from(messageRequests)
          .where(
            and(
              eq(
                messageRequests.id,
                requestId,
              ),
              eq(
                messageRequests.recipientId,
                req.auth!.subjectId,
              ),
            ),
          )
          .limit(1);

      if (!request) {
        return res
          .status(404)
          .json({
            error:
              "Message request not found.",
          });
      }

      const status =
        parsed.data.action ===
        "accept"
          ? "accepted"
          : "declined";

      await db
        .update(messageRequests)
        .set({
          status,
          updatedAt:
            new Date(),
        })
        .where(
          eq(
            messageRequests.id,
            requestId,
          ),
        );

      const conversationId =
        status === "accepted"
          ? (
              await findConversation(
                request.senderId,
                request.recipientId,
              )
            ) ??
            (await createConversation(
              request.senderId,
              request.recipientId,
            ))
          : null;

      return res.json({
        data: {
          ...request,
          status,
          conversationId,
        },
      });
    }

    const request =
      requestsMemory.get(
        requestId,
      );

    if (
      !request ||
      request.recipientId !==
        req.auth!.subjectId
    ) {
      return res
        .status(404)
        .json({
          error:
            "Message request not found.",
        });
    }

    request.status =
      parsed.data.action ===
      "accept"
        ? "accepted"
        : "declined";

    const conversationId =
      request.status === "accepted"
        ? (
            await findConversation(
              request.senderId,
              request.recipientId,
            )
          ) ??
          (await createConversation(
            request.senderId,
            request.recipientId,
          ))
        : null;

    return res.json({
      data: {
        ...request,
        conversationId,
      },
    });
  },
);

/*
 * ------------------------------------------------
 * Conversation list
 * ------------------------------------------------
 */

messagesRouter.get(
  "/",
  requireAuth,
  async (req, res) => {
    const database = db;

    if (!database) {
      return res.json({
        data: [
          ...conversationsMemory.values(),
        ]
          .filter((item) =>
            item.members.includes(
              req.auth!.subjectId,
            ),
          )
          .map((item) => ({
            id: item.id,

            lastMessage:
              item.messages.at(-1) ??
              null,
          })),
      });
    }

    const memberships =
      await database
        .select({
          conversationId:
            conversationMembers.conversationId,
        })
        .from(conversationMembers)
        .where(
          eq(
            conversationMembers.userId,
            req.auth!.subjectId,
          ),
        );

    const data =
      await Promise.all(
        memberships.map(
          async ({
            conversationId,
          }) => {
            const members =
              await database
                .select({
                  id: users.id,
                  name: users.name,
                  username:
                    users.username,
                  avatarUrl:
                    users.avatarUrl,
                  accountType:
                    users.accountType,

                  messagingPublicKey:
                    users.messagingPublicKey,

                  messagingKeyVersion:
                    users.messagingKeyVersion,
                })
                .from(
                  conversationMembers,
                )
                .innerJoin(
                  users,
                  eq(
                    conversationMembers.userId,
                    users.id,
                  ),
                )
                .where(
                  eq(
                    conversationMembers.conversationId,
                    conversationId,
                  ),
                );

            const participant =
              members.find(
                (member) =>
                  member.id !==
                  req.auth!.subjectId,
              ) ?? null;

            const [lastMessage] =
              await database
                .select()
                .from(dbMessages)
                .where(
                  eq(
                    dbMessages.conversationId,
                    conversationId,
                  ),
                )
                .orderBy(
                  desc(
                    dbMessages.createdAt,
                  ),
                )
                .limit(1);

            return {
              id: conversationId,

              participant,

              lastMessage:
                lastMessage
                  ? serializeMessage(
                      lastMessage,
                    )
                  : null,
            };
          },
        ),
      );

    return res.json({
      data,
    });
  },
);

/*
 * ------------------------------------------------
 * Send message through HTTP
 *
 * WebSocket is preferred by the frontend,
 * but this route remains available.
 * ------------------------------------------------
 */

messagesRouter.post(
  "/",
  requireAuth,
  async (req, res) => {
    const parsed = z
      .object({
        recipientId:
          z.string().uuid(),

        ciphertext:
          z.string()
            .min(1)
            .max(20000),

        iv:
          z.string()
            .min(1)
            .max(2000),

        senderKey:
          z.string()
            .min(1)
            .max(10000),

        recipientKey:
          z.string()
            .min(1)
            .max(10000),

        encryptionVersion:
          z.number()
            .int()
            .positive()
            .default(1),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res
        .status(400)
        .json({
          error:
            "Encrypted message payload is invalid.",
        });
    }

    if (
      !(await acceptedRequest(
        req.auth!.subjectId,
        parsed.data.recipientId,
      ))
    ) {
      return res
        .status(403)
        .json({
          error:
            "Accept the message request before sending messages.",
        });
    }

    const conversationId =
      (await findConversation(
        req.auth!.subjectId,
        parsed.data.recipientId,
      )) ??
      (await createConversation(
        req.auth!.subjectId,
        parsed.data.recipientId,
      ));

    if (db) {
      const [created] =
        await db
          .insert(dbMessages)
          .values({
            conversationId,

            senderId:
              req.auth!.subjectId,

            body: "",

            ciphertext:
              parsed.data.ciphertext,

            iv:
              parsed.data.iv,

            senderKey:
              parsed.data.senderKey,

            recipientKey:
              parsed.data.recipientKey,

            encryptionVersion:
              parsed.data
                .encryptionVersion,
          })
          .returning();

      await db
        .update(conversations)
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

      return res
        .status(201)
        .json({
          data:
            serializeMessage(
              created,
            ),
        });
    }

    const conversation =
      conversationsMemory.get(
        conversationId,
      )!;

    const created: EncryptedMessage =
      {
        id: randomUUID(),

        conversationId,

        senderId:
          req.auth!.subjectId,

        body: "",

        ciphertext:
          parsed.data.ciphertext,

        iv:
          parsed.data.iv,

        senderKey:
          parsed.data.senderKey,

        recipientKey:
          parsed.data.recipientKey,

        encryptionVersion:
          parsed.data
            .encryptionVersion,

        deliveredAt: null,

        readAt: null,

        createdAt:
          new Date().toISOString(),
      };

    conversation.messages.push(
      created,
    );

    return res
      .status(201)
      .json({
        data: created,
      });
  },
);

/*
 * ------------------------------------------------
 * Get conversation messages
 * ------------------------------------------------
 */

messagesRouter.get(
  "/:conversationId",
  requireAuth,
  async (req, res) => {
    const conversationId =
      String(
        req.params.conversationId,
      );

    if (!db) {
      const item =
        conversationsMemory.get(
          conversationId,
        );

      if (
        !item ||
        !item.members.includes(
          req.auth!.subjectId,
        )
      ) {
        return res
          .status(404)
          .json({
            error:
              "Conversation not found.",
          });
      }

      return res.json({
        data: item.messages,
      });
    }

    /*
     * Verify that the current user
     * belongs to this conversation.
     */
    const [membership] =
      await db
        .select()
        .from(conversationMembers)
        .where(
          and(
            eq(
              conversationMembers.conversationId,
              conversationId,
            ),

            eq(
              conversationMembers.userId,
              req.auth!.subjectId,
            ),
          ),
        )
        .limit(1);

    if (!membership) {
      return res
        .status(404)
        .json({
          error:
            "Conversation not found.",
        });
    }

    const rows =
      await db
        .select()
        .from(dbMessages)
        .where(
          eq(
            dbMessages.conversationId,
            conversationId,
          ),
        )
        .orderBy(
          dbMessages.createdAt,
        );

    /*
     * IMPORTANT:
     *
     * Return deliveredAt and readAt.
     *
     * This is what allows the frontend
     * to restore:
     *
     * ✓   sent
     * ✓✓  delivered
     * ✓✓  read
     *
     * after a refresh.
     */
    return res.json({
      data: rows.map(
        serializeMessage,
      ),
    });
  },
);