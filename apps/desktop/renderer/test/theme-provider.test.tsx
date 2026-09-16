import { render, screen } from "@testing-library/react";
import { ConfigProvider, theme } from "antd";
import { DSProvider, getDSSeedTokens } from "@fullstack-ai-infra/ui";
import { describe, expect, it } from "vitest";

function TokenProbe() {
  const { token } = theme.useToken();
  return <output data-testid="theme-pair">{`${token.colorBgContainer}|${token.colorText}`}</output>;
}

describe("linked design-system provider identity", () => {
  for (const profile of ["default", "mint"] as const) {
    for (const mode of ["light", "dark"] as const) {
      it(`passes ${profile} ${mode} surfaces through the desktop's nested Ant provider`, () => {
        render(<DSProvider mode={mode} profile={profile}>
          <ConfigProvider theme={{ token: { fontFamily: "Inter" } }}><TokenProbe /></ConfigProvider>
        </DSProvider>);
        const expected = getDSSeedTokens(profile, mode);
        expect(screen.getByTestId("theme-pair")).toHaveTextContent(`${expected.colorBgContainer}|${expected.colorText}`);
      });
    }
  }
});
