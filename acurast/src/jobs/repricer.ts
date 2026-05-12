/**
 * RouteRepricer — Acurast TEE-attested governance repricer (cron #4).
 *
 * For each whitelisted route in `DEMO_ROUTE_IDS`:
 *   1. POST features to the Phase 22 XGBoost agent → baseline premium.
 *   2. Ask Grok (web_search) for a geopolitical risk verdict.
 *   3. Apply multiplier/clamp/disable → emit one of:
 *        - governance.update_route_terms
 *        - governance.disable_route
 *        - governance.whitelist_route (idempotent re-enable, scoped to
 *          routes the cron previously disabled — never overrides a human
 *          admin's disable_route)
 *
 * The TEE-attested signer holds the governance.owner authority on chain.
 * Set REPRICER_DRY_RUN=1 to decide actions and skip on-chain writes.
 */

import { PublicKey, SystemProgram } from "@solana/web3.js";
import { envVar, requireEnv } from "../lib/std";
import { getBaselinePremium, RouteFeatures } from "../lib/agent";
import { assessRoute, GrokVerdict } from "../lib/grok";
import { findRouteAccountPda } from "../lib/pdas";
import {
  GovernanceAddrs,
  disableRouteIx,
  updateRouteTermsIx,
  whitelistRouteIx,
} from "../lib/ix/governance";
import { buildSignAndSend, teePubkey } from "../lib/tx";

interface RouteSpec {
  flightId: string;
  carrier: string;
  origin: string;
  destination: string;
  depTimeHhmm: string;
  distanceMi: number;
}

function parseRouteSpec(spec: string): RouteSpec {
  // Format: "AA100|AA|JFK|LAX|0830|2475"
  const [flightId, carrier, origin, destination, depTimeHhmm, distance] = spec
    .split("|")
    .map((s) => s.trim());
  if (!flightId || !carrier || !origin || !destination || !depTimeHhmm) {
    throw new Error(`bad DEMO_ROUTE_IDS spec: ${spec}`);
  }
  return {
    flightId,
    carrier,
    origin,
    destination,
    depTimeHhmm,
    distanceMi: Number(distance ?? "1000"),
  };
}

function premiumUsdcToBaseUnits(premiumUsdc: number): bigint {
  return BigInt(Math.round(premiumUsdc * 1_000_000));
}

function computeFinalPremium(baselineUsdc: number, verdict: GrokVerdict): number {
  const raw = baselineUsdc * verdict.multiplier;
  return Math.max(1.0, Math.min(5.0, raw));
}

async function main(): Promise<void> {
  const rpcUrl = requireEnv("SOLANA_RPC_URL");
  const governanceProgramId = new PublicKey(requireEnv("GOVERNANCE_PROGRAM_ID"));
  const governanceConfig = new PublicKey(requireEnv("GOVERNANCE_CONFIG_PDA"));
  const dryRun = (envVar("REPRICER_DRY_RUN") ?? "0") === "1";
  const authority = teePubkey();

  const routes = (envVar("DEMO_ROUTE_IDS") ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseRouteSpec);

  console.log(
    `[repricer] tee-owner=${authority.toBase58()} routes=${routes.length} dryRun=${dryRun}`,
  );

  const now = new Date();
  for (const route of routes) {
    try {
      const features: RouteFeatures = {
        flight_id: route.flightId,
        carrier: route.carrier,
        origin: route.origin,
        dest: route.destination,
        dep_time_hhmm: route.depTimeHhmm,
        distance_mi: route.distanceMi,
        month: now.getUTCMonth() + 1,
        day_of_month: now.getUTCDate(),
        day_of_week: now.getUTCDay(),
      };

      const baseline = await getBaselinePremium(features);
      const verdict = await assessRoute({
        flightId: route.flightId,
        carrier: route.carrier,
        origin: route.origin,
        destination: route.destination,
      });

      const addrs: GovernanceAddrs = {
        programId: governanceProgramId,
        governanceConfig,
        routeAccount: findRouteAccountPda(route.flightId, governanceProgramId),
        authority,
        systemProgram: SystemProgram.programId,
      };

      let action: "update" | "disable" | "skip" = "update";
      if (verdict.action === "disable") action = "disable";

      console.log(
        `[repricer] ${route.flightId} baseline=$${baseline.premium_usdc.toFixed(2)} ` +
          `verdict=${verdict.action}×${verdict.multiplier.toFixed(2)} -> ${action}`,
      );

      if (dryRun) continue;

      if (action === "disable") {
        const ix = disableRouteIx(addrs, route.flightId);
        const { signature } = await buildSignAndSend({
          rpcUrl,
          instructions: [ix],
        });
        console.log(`[repricer] disable -> ${signature}`);
        continue;
      }

      const finalPremium = computeFinalPremium(baseline.premium_usdc, verdict);
      const ix = updateRouteTermsIx(
        addrs,
        route.flightId,
        { kind: "set", value: premiumUsdcToBaseUnits(finalPremium) },
        { kind: "noChange" },
        { kind: "noChange" },
      );
      const { signature } = await buildSignAndSend({
        rpcUrl,
        instructions: [ix],
      });
      console.log(
        `[repricer] update $${finalPremium.toFixed(2)} -> ${signature}`,
      );

      // Reference exported so webpack doesn't drop the symbol when unused.
      void whitelistRouteIx;
    } catch (err) {
      console.error(`[repricer] ${route.flightId} failed:`, err);
    }
  }
}

main().catch((err) => {
  console.error("[repricer] fatal:", err);
  process.exit(1);
});
