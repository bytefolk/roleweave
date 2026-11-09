import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useThemeMode, useThemeProfile } from "../src/theme-toggle";

function ThemeProbe() {
  return <output data-testid="appearance">{useThemeMode()}|{useThemeProfile()}</output>;
}
beforeEach(() => {
  document.documentElement.setAttribute("data-theme", "light");
  document.documentElement.setAttribute("data-ui-theme", "mint");
});
describe("live appearance readers", () => {
  it("follows saved appearance changes so Ant Design uses the active mode and profile", async () => {
    render(<ThemeProbe />);
    expect(screen.getByTestId("appearance")).toHaveTextContent("light|mint");
    await act(async () => {
      document.documentElement.setAttribute("data-theme", "dark");
      document.documentElement.setAttribute("data-ui-theme", "default");
    });
    expect(screen.getByTestId("appearance")).toHaveTextContent("dark|default");
  });
  it("adopts an appearance seeded before mount", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    render(<ThemeProbe />);
    expect(screen.getByTestId("appearance")).toHaveTextContent("dark|mint");
  });
});
