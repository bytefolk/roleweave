import { useState } from "react";
import { Button, Descriptions, Drawer, Empty, Typography } from "antd";
import { useT } from "@roleweave/ui";
import { loadShelfListings, SHELF_SOURCE_IS_FIXTURE, type ShelfListing } from "./shelf-fixture";
import "./shelf.css";

export interface ShelfModuleProps {
  /** Funnels into the existing hire flow instead of a second creation path.
   *  Wired, but unreachable while the read seam is fixture-only: a fixture row
   *  carries a seller tenant, `packageDigest` and a RateCard snapshot that no
   *  server here can accept yet, so hiring stays disabled (#544). */
  onHire: (listing: ShelfListing) => void;
}

const { Text, Title } = Typography;

const ENGINE_LABEL: Record<string, string> = {
  qoder: "Qoder",
  claude: "Claude",
  codebuddy: "CodeBuddy",
  qwen: "Qwen",
};

function engineLabel(engine: string): string {
  return ENGINE_LABEL[engine] ?? engine;
}

function listingTitle(listing: ShelfListing): string {
  return `${listing.employeeId} · v${listing.employeeVersion}`;
}

/**
 * Buyer-side shelf entry: list published listings and open one.
 *
 * Read-only by design. The listing contract belongs to the marketplace
 * control plane and the fields rendered here mirror it verbatim
 * (`shelf-fixture.ts` documents the source); this module never authors a
 * listing field of its own.
 *
 * Hiring is unavailable while `SHELF_SOURCE_IS_FIXTURE` holds. Opening the
 * local create-from-scratch hire drawer from an example row would hire a
 * look-alike local employee instead of the listing, so the control is disabled
 * and says so rather than opening a path it cannot honour.
 */
export function ShelfModule({ onHire }: ShelfModuleProps) {
  const t = useT();
  const listings = loadShelfListings();
  const hireAvailable = !SHELF_SOURCE_IS_FIXTURE;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = listings.find((listing) => listing.listingId === selectedId) ?? null;

  return (
    <section className="owb-shelf" aria-label={t("shelf.title")}>
      <header className="owb-shelf__header">
        <div className="owb-shelf__intro">
          <Title level={4} className="owb-shelf__title">
            {t("shelf.title")}
          </Title>
          <Text type="secondary">{t("shelf.subtitle")}</Text>
        </div>
        <Text type="secondary" className="owb-shelf__badge">
          {t("shelf.fixtureBadge")}
        </Text>
      </header>

      {listings.length === 0 ? (
        <Empty description={t("shelf.empty")} />
      ) : (
        <ul className="owb-shelf__list">
          {listings.map((listing) => (
            <li key={listing.listingId} className="owb-shelf__row">
              <div className="owb-shelf__row-main">
                <span className="owb-shelf__row-title">{listingTitle(listing)}</span>
                <span className="owb-shelf__row-meta">
                  {engineLabel(listing.engine)} ·{" "}
                  {t("shelf.baseCredits", { credits: listing.rateCardSnapshot.baseCredits })}
                </span>
              </div>
              <Button type="link" onClick={() => setSelectedId(listing.listingId)}>
                {t("shelf.detail")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Drawer
        open={selected !== null}
        rootClassName="owb-shelf-drawer"
        title={selected ? listingTitle(selected) : ""}
        onClose={() => setSelectedId(null)}
        destroyOnHidden
        footer={
          selected ? (
            <div className="owb-shelf__actions">
              <div className="owb-shelf__action">
                <Button type="primary" disabled={!hireAvailable} onClick={() => onHire(selected)}>
                  {t("shelf.hire")}
                </Button>
                {hireAvailable ? null : (
                  <Text type="secondary" className="owb-shelf__reason">
                    {t("shelf.hireUnavailable")}
                  </Text>
                )}
              </div>
            </div>
          ) : null
        }
      >
        {selected ? (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label={t("shelf.field.listingId")}>
              {selected.listingId}
            </Descriptions.Item>
            <Descriptions.Item label={t("shelf.field.engine")}>
              {engineLabel(selected.engine)}
            </Descriptions.Item>
            <Descriptions.Item label={t("shelf.field.employeeVersion")}>
              {selected.employeeVersion}
            </Descriptions.Item>
            <Descriptions.Item label={t("shelf.field.baseCredits")}>
              {selected.rateCardSnapshot.baseCredits}
            </Descriptions.Item>
            <Descriptions.Item label={t("shelf.field.inputCredits")}>
              {selected.rateCardSnapshot.inputCreditsPerThousandTokens}
            </Descriptions.Item>
            <Descriptions.Item label={t("shelf.field.outputCredits")}>
              {selected.rateCardSnapshot.outputCreditsPerThousandTokens}
            </Descriptions.Item>
            <Descriptions.Item label={t("shelf.field.publishedAt")}>
              {selected.publishedAt}
            </Descriptions.Item>
          </Descriptions>
        ) : null}
      </Drawer>
    </section>
  );
}
