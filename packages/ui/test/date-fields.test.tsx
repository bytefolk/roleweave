import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import dayjs from "dayjs";
import { DateField, DateTimeRangeField, type DateTimeRange } from "../src/date-fields";
import { OwbI18nProvider } from "../src/i18n";

function enterDate(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
}

describe("DateField", () => {
  it("commits calendar selection as a date-only string and reflects controlled updates", () => {
    const onChange = vi.fn();
    const { rerender } = render(<DateField aria-label="Start" value="2026-09-22" onChange={onChange} />);
    const input = screen.getByLabelText("Start");
    expect(input).toHaveValue("2026-09-22");
    fireEvent.click(input);
    fireEvent.click(document.querySelector('td[title="2026-09-25"]')!);
    expect(onChange).toHaveBeenCalledWith("2026-09-25");
    rerender(<DateField aria-label="Start" value="2026-09-25" onChange={onChange} />);
    expect(input).toHaveValue("2026-09-25");
    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(onChange).toHaveBeenLastCalledWith("");
    rerender(<DateField aria-label="Start" value="" onChange={onChange} />);
    expect(input).toHaveValue("");
  });

  it("rejects out-of-range keyboard input and disables calendar dates beyond both bounds", () => {
    const onChange = vi.fn();
    render(<DateField aria-label="Date" value="2026-09-22" min="2026-09-20" max="2026-09-25" onChange={onChange} />);
    const input = screen.getByLabelText("Date");
    fireEvent.click(input);
    expect(document.querySelector('td[title="2026-09-19"]')).toHaveClass("ant-picker-cell-disabled");
    expect(document.querySelector('td[title="2026-09-26"]')).toHaveClass("ant-picker-cell-disabled");
    enterDate(input, "2026-09-26");
    expect(onChange).not.toHaveBeenCalled();
    enterDate(input, "2026-09-19");
    expect(onChange).not.toHaveBeenCalled();
    enterDate(input, "2026-09-25");
    expect(onChange).toHaveBeenCalledWith("2026-09-25");
  });

  it.each(["2026-02-30", "not-a-date"])("does not normalize invalid stored date %s into a different day", (value) => {
    render(<DateField aria-label="Date" value={value} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Date")).toHaveValue("");
  });

  it("uses the app locale for calendar text and switches it without a remount", () => {
    const field = <DateField aria-label="Date" value="2026-09-22" onChange={vi.fn()} />;
    const { rerender } = render(<OwbI18nProvider locale="zh-CN">{field}</OwbI18nProvider>);
    fireEvent.click(screen.getByLabelText("Date"));
    expect(document.querySelector(".ant-picker-month-btn")).toHaveTextContent("9月");
    rerender(<OwbI18nProvider locale="en">{field}</OwbI18nProvider>);
    expect(document.querySelector(".ant-picker-month-btn")).toHaveTextContent("Sep");
  });
});

describe("DateTimeRangeField", () => {
  it("displays ISO bounds in local time, supports open-ended ranges and clears both bounds", () => {
    const onChange = vi.fn();
    const from = "2026-09-22T08:30:45.000Z";
    const to = "2026-09-23T10:15:30.000Z";
    const { container, rerender } = render(<DateTimeRangeField value={[from, to]} onChange={onChange} />);
    const inputs = within(container).getAllByRole("textbox");
    expect(inputs[0]).toHaveValue(dayjs(from).format("YYYY-MM-DD HH:mm:ss"));
    expect(inputs[1]).toHaveValue(dayjs(to).format("YYYY-MM-DD HH:mm:ss"));
    rerender(<DateTimeRangeField value={[from, undefined]} onChange={onChange} />);
    expect(inputs[0]).toHaveValue(dayjs(from).format("YYYY-MM-DD HH:mm:ss"));
    expect(inputs[1]).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(onChange).toHaveBeenCalledWith([undefined, undefined]);
  });

  it("commits entered local times as ISO instants and reflects them in controlled state", () => {
    const onChange = vi.fn();
    function ControlledRange() {
      const [value, setValue] = useState<DateTimeRange>([undefined, undefined]);
      return <DateTimeRangeField value={value} onChange={(next) => { setValue(next); onChange(next); }} />;
    }
    const { container } = render(<ControlledRange />);
    const inputs = within(container).getAllByRole("textbox");
    fireEvent.click(inputs[0]!);
    enterDate(inputs[0]!, "2026-09-22 09:30:45");
    fireEvent.click(inputs[1]!);
    enterDate(inputs[1]!, "2026-09-23 18:15:30");
    expect(onChange).toHaveBeenLastCalledWith([
      dayjs("2026-09-22 09:30:45").toISOString(),
      dayjs("2026-09-23 18:15:30").toISOString(),
    ]);
    expect(inputs[0]).toHaveValue("2026-09-22 09:30:45");
    expect(inputs[1]).toHaveValue("2026-09-23 18:15:30");
  });
});
