import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShelfModule } from "../src/shelf/ShelfModule";
import { SHELF_FIXTURE, type ShelfListing } from "../src/shelf/shelf-fixture";

/**
 * The shelf is the buyer-side read surface of the marketplace listing contract.
 * These tests pin that it renders whatever the read seam returns, exposes the
 * listing fields verbatim, and never authors a listing of its own.
 */

/** Row-scoped lookup: never depend on the order of rendered listings. */
function openDetail(listing: ShelfListing): void {
  const row = screen.getByText(`${listing.employeeId} · v${listing.employeeVersion}`).closest("li");
  if (!row) throw new Error("listing row not found");
  fireEvent.click(within(row).getByRole("button", { name: "详情" }));
}

describe("shelf module", () => {
  it("lists every published listing from the read seam", () => {
    render(<ShelfModule workspaceOpen onHire={() => {}} />);
    for (const listing of SHELF_FIXTURE) {
      expect(screen.getByText(`${listing.employeeId} · v${listing.employeeVersion}`)).toBeInTheDocument();
    }
  });

  it("shows the listing's own fields in the detail drawer", async () => {
    const listing = SHELF_FIXTURE[0]!;
    render(<ShelfModule workspaceOpen onHire={() => {}} />);
    openDetail(listing);
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText(listing.listingId)).toBeInTheDocument();
    expect(within(drawer).getByText(listing.employeeVersion)).toBeInTheDocument();
    expect(within(drawer).getByText(listing.rateCardSnapshot.baseCredits)).toBeInTheDocument();
    expect(within(drawer).getByText(listing.rateCardSnapshot.inputCreditsPerThousandTokens)).toBeInTheDocument();
  });

  it("hands the selected listing to the existing hire flow", async () => {
    const onHire = vi.fn();
    const listing = SHELF_FIXTURE[1]!;
    render(<ShelfModule workspaceOpen onHire={onHire} />);
    openDetail(listing);
    // antd inserts a space between the two CJK glyphs of a primary button's
    // label, so match on the accessible name with that gap tolerated.
    fireEvent.click(await screen.findByRole("button", { name: /雇\s*用/ }));
    expect(onHire).toHaveBeenCalledTimes(1);
    expect(onHire).toHaveBeenCalledWith(listing);
  });

  it("refuses to start a hire without an open workspace", async () => {
    render(<ShelfModule workspaceOpen={false} onHire={() => {}} />);
    openDetail(SHELF_FIXTURE[0]!);
    expect(await screen.findByRole("button", { name: "请先打开工作区再雇用" })).toBeDisabled();
  });
});
