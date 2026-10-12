import { fireEvent } from "@testing-library/react";

/** Ant Design commits typed dates on Enter instead of on every keystroke. */
export function enterPickerDate(control: HTMLElement, value: string) {
  const input = control instanceof HTMLInputElement ? control : control.querySelector("input");
  if (!input) throw new Error("Date picker has no input");
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
}
