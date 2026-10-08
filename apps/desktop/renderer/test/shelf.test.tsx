import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShelfModule } from "../src/shelf/ShelfModule";
import { SHELF_FIXTURE, SHELF_SOURCE_IS_FIXTURE, type ShelfListing } from "../src/shelf/shelf-fixture";

/**
 * The shelf is the buyer-side read surface of the marketplace listing contract.
 * These tests pin that it renders whatever the read seam returns, exposes the
 * listing fields verbatim, never authors a listing of its own, and does not
 * offer a hire it cannot honour while the seam is fixture-only.
 */

/** Row-scoped lookup: never depend on the order of rendered listings. */
function openDetail(listing: ShelfListing): void {
  const row = screen.getByText(`${listing.employeeId} · v${listing.employeeVersion}`).closest("li");
  if (!row) throw new Error("listing row not found");
  fireEvent.click(within(row).getByRole("button", { name: "详情" }));
}

describe("shelf module", () => {
  it("lists every published listing from the read seam", () => {
    render(<ShelfModule onHire={() => {}} />);
    for (const listing of SHELF_FIXTURE) {
      expect(screen.getByText(`${listing.employeeId} · v${listing.employeeVersion}`)).toBeInTheDocument();
    }
  });

  it("shows the listing's own fields in the detail drawer", async () => {
    const listing = SHELF_FIXTURE[0]!;
    render(<ShelfModule onHire={() => {}} />);
    openDetail(listing);
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText(listing.listingId)).toBeInTheDocument();
    expect(within(drawer).getByText(listing.employeeVersion)).toBeInTheDocument();
    expect(within(drawer).getByText(listing.rateCardSnapshot.baseCredits)).toBeInTheDocument();
    expect(within(drawer).getByText(listing.rateCardSnapshot.inputCreditsPerThousandTokens)).toBeInTheDocument();
  });

  it("says it is a preview over example data rather than promising a hire", () => {
    render(<ShelfModule onHire={() => {}} />);
    expect(screen.getByText("功能预览：当前为示例数据，暂不可雇用。")).toBeInTheDocument();
    expect(screen.getByText("示例数据 · 功能预览")).toBeInTheDocument();
  });

  it("never opens the hire flow while the read seam returns fixtures", async () => {
    const onHire = vi.fn();
    render(<ShelfModule onHire={onHire} />);
    openDetail(SHELF_FIXTURE[0]!);
    // antd inserts a space between the two CJK glyphs of a primary button's
    // label, so match on the accessible name with that gap tolerated.
    const hire = await screen.findByRole("button", { name: /雇\s*用/ });
    expect(hire).toBeDisabled();
    // The listing record reaches the callback, so the only thing standing
    // between an example row and a local look-alike hire is this control.
    fireEvent.click(hire);
    expect(onHire).not.toHaveBeenCalled();
    // ... and the drawer says why, in the same place the control is.
    expect(within(hire.closest(".owb-shelf__action") as HTMLElement).getByText(/示例数据不可雇用/)).toBeInTheDocument();
  });

  it("pins the fixture-only read seam that the disabled hire control depends on", () => {
    // Flipping this constant is how digital-employee-platform#21 unblocks #544.
    // If it flips without the hire path being wired, the control above enables
    // itself against a data source nobody has implemented yet.
    expect(SHELF_SOURCE_IS_FIXTURE).toBe(true);
  });
});
