import { Hono } from "hono";
import { auth } from "../lib/auth.js";
import { db } from "../db/index.js";
import { entitlement, plan, subscription } from "../db/schema.js";
import { and, eq } from "drizzle-orm";

type Variables = {
  user: { id: string; name: string; email: string; image?: string | null };
};

export const subscriptionRoutes = new Hono<{ Variables: Variables }>();

// Payments are only functional once the server holds provider credentials.
// Prices are NEVER hardcoded: they come from the `plans` table which is
// populated from provider product IDs supplied by the client.
function paymentsConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY || process.env.PAYMENTS_ENABLED === "true");
}

async function currentUser(c: any) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

async function entitlementsFor(userId: string): Promise<string[]> {
  const rows = await db.select({ key: entitlement.key }).from(entitlement).where(eq(entitlement.userId, userId));
  return rows.map((r) => r.key);
}

// GET /api/plans -> public catalogue (empty until the client configures products)
subscriptionRoutes.get("/plans", async (c) => {
  const rows = await db.select().from(plan).where(eq(plan.active, true));
  return c.json({
    plans: rows.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      interval: p.interval,
      priceCents: p.priceCents,
      currency: p.currency,
      features: p.features ?? [],
    })),
    paymentsConfigured: paymentsConfigured(),
  });
});

// GET /api/subscription -> current user's access state
subscriptionRoutes.get("/subscription", async (c) => {
  const user = await currentUser(c);
  if (!user) {
    return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
  }

  const [sub] = await db.select().from(subscription).where(eq(subscription.userId, user.id)).limit(1);
  const keys = await entitlementsFor(user.id);

  return c.json({
    subscription: sub ?? { status: "free", cancelAtPeriodEnd: false },
    entitlements: keys,
    paymentsConfigured: paymentsConfigured(),
  });
});

// POST /api/subscription/checkout { planId } -> provider checkout URL
subscriptionRoutes.post("/subscription/checkout", async (c) => {
  const user = await currentUser(c);
  if (!user) {
    return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
  }

  const payload = await c.req.json().catch(() => ({}));
  const planId = typeof payload?.planId === "string" ? payload.planId : "";
  if (!planId) {
    return c.json({ error: "invalid_request", message: "planId is required" }, 400);
  }

  const [selected] = await db
    .select()
    .from(plan)
    .where(and(eq(plan.id, planId), eq(plan.active, true)))
    .limit(1);
  if (!selected) {
    return c.json({ error: "not_found", message: "Plan not found" }, 404);
  }

  if (!paymentsConfigured()) {
    return c.json(
      {
        error: "payments_not_configured",
        message: "Payments are not enabled on this server. Configure a provider before checkout.",
      },
      503
    );
  }

  // Provider integration (Stripe / RevenueCat) goes here. The amount is taken
  // from the plan's providerProductId, never from the client.
  return c.json(
    {
      error: "not_implemented",
      message: "Checkout session creation is pending provider integration.",
    },
    501
  );
});

// POST /api/subscription/webhook -> provider events (signature-verified)
subscriptionRoutes.post("/subscription/webhook", async (c) => {
  if (!paymentsConfigured()) {
    return c.json({ error: "payments_not_configured" }, 503);
  }
  // Verify provider signature, then upsert subscription/entitlements.
  return c.json({ error: "not_implemented" }, 501);
});
