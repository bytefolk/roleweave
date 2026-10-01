/**
 * Shelf fixtures.
 *
 * The buyer-side shelf only *reads* the marketplace listing contract. The
 * field names below are a deliberate mirror of
 * `digital-employee-platform/src/catalog/listing.ts` (`ListingVersion`,
 * `LISTING_RECORD_SCHEMA_VERSION`) and `src/rate-card.ts`
 * (`RateCardSnapshotV1`), so this module never invents a listing field.
 *
 * Until the platform exposes a buyer-facing HTTP surface
 * (`digital-employee-platform#21`), the shelf renders these fixtures. When that
 * endpoint lands, only `loadShelfListings()` below has to change.
 */

/** `digital-employee-platform` `catalog-listing.v1`. */
export const LISTING_RECORD_SCHEMA_VERSION = "catalog-listing.v1" as const;
export const RATE_CARD_SNAPSHOT_SCHEMA_VERSION = "rate-card-snapshot.v1" as const;

/** JSON-safe decimal string used by the platform's snapshot codec. */
export type DecimalCreditString = string;

/** Mirror of the platform's `RateCardSnapshotV1`. */
export interface RateCardSnapshot {
  readonly schemaVersion: typeof RATE_CARD_SNAPSHOT_SCHEMA_VERSION;
  readonly rateCardId: string;
  readonly sellerId: string;
  readonly employeeId: string;
  readonly version: number;
  readonly baseCredits: DecimalCreditString;
  readonly inputCreditsPerThousandTokens: DecimalCreditString;
  readonly outputCreditsPerThousandTokens: DecimalCreditString;
  readonly durationCreditsPerSecond: DecimalCreditString;
  readonly actionCredits: Readonly<Record<string, DecimalCreditString>>;
  readonly platformFeeBps: number;
  readonly effectiveAt: string;
}

/** Mirror of the platform's `ListingVersion`. */
export interface ShelfListing {
  readonly schemaVersion: typeof LISTING_RECORD_SCHEMA_VERSION;
  readonly listingId: string;
  readonly version: number;
  readonly sellerId: string;
  readonly sellerTenantId: string;
  readonly employeeId: string;
  readonly employeeVersion: string;
  readonly packageDigest: string;
  readonly engine: string;
  readonly rateCardId: string;
  readonly rateCardVersion: number;
  readonly rateCardSnapshot: RateCardSnapshot;
  readonly publishedAt: string;
  readonly status: "published";
  readonly recordDigest: string;
}

const SELLER = { partyId: "seller-acme", tenantId: "tenant-acme" } as const;

function rateCard(input: {
  employeeId: string;
  version: number;
  base: string;
  input: string;
  output: string;
}): RateCardSnapshot {
  return {
    schemaVersion: RATE_CARD_SNAPSHOT_SCHEMA_VERSION,
    rateCardId: `rc-${input.employeeId}`,
    sellerId: SELLER.partyId,
    employeeId: input.employeeId,
    version: input.version,
    baseCredits: input.base,
    inputCreditsPerThousandTokens: input.input,
    outputCreditsPerThousandTokens: input.output,
    durationCreditsPerSecond: "0",
    actionCredits: {},
    platformFeeBps: 1500,
    effectiveAt: "2026-09-01T00:00:00.000Z",
  };
}

/** Fixture rows. Digest-shaped strings are placeholders, never verified here. */
export const SHELF_FIXTURE: readonly ShelfListing[] = [
  {
    schemaVersion: LISTING_RECORD_SCHEMA_VERSION,
    listingId: "listing-support-agent",
    version: 1,
    sellerId: SELLER.partyId,
    sellerTenantId: SELLER.tenantId,
    employeeId: "employee-support-agent",
    employeeVersion: "1.4.0",
    packageDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
    engine: "qoder",
    rateCardId: "rc-employee-support-agent",
    rateCardVersion: 3,
    rateCardSnapshot: rateCard({ employeeId: "employee-support-agent", version: 3, base: "120", input: "0.4", output: "1.2" }),
    publishedAt: "2026-09-20T02:10:00.000Z",
    status: "published",
    recordDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000011",
  },
  {
    schemaVersion: LISTING_RECORD_SCHEMA_VERSION,
    listingId: "listing-data-analyst",
    version: 2,
    sellerId: SELLER.partyId,
    sellerTenantId: SELLER.tenantId,
    employeeId: "employee-data-analyst",
    employeeVersion: "2.0.1",
    packageDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000002",
    engine: "claude",
    rateCardId: "rc-employee-data-analyst",
    rateCardVersion: 5,
    rateCardSnapshot: rateCard({ employeeId: "employee-data-analyst", version: 5, base: "260", input: "0.6", output: "1.8" }),
    publishedAt: "2026-09-24T07:40:00.000Z",
    status: "published",
    recordDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000022",
  },
];

/**
 * Single read seam. Replace the body with the platform's buyer-facing read
 * (`digital-employee-platform#21`) once it exists; callers stay unchanged.
 */
export function loadShelfListings(): readonly ShelfListing[] {
  return SHELF_FIXTURE;
}
