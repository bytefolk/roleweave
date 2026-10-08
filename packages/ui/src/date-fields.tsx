import { DatePicker, type DatePickerProps } from "antd";
import enUS from "antd/es/date-picker/locale/en_US";
import zhCN from "antd/es/date-picker/locale/zh_CN";
import dayjs, { type Dayjs } from "dayjs";
import "dayjs/locale/zh-cn";
import { useOwbLocale } from "./i18n";

const DATE_FORMAT = "YYYY-MM-DD";
const DATE_TIME_FORMAT = "YYYY-MM-DD HH:mm:ss";

type FieldProps = Pick<DatePickerProps, "id" | "className" | "size" | "disabled" | "status" | "aria-label"> & {
  "data-testid"?: string;
};

export interface DateFieldProps extends FieldProps {
  value?: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
}

function calendarDate(value?: string): Dayjs | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = dayjs(value);
  return date.isValid() && date.format(DATE_FORMAT) === value ? date : null;
}

/** Calendar dates stay as date-only strings; never convert them through UTC. */
export function DateField({ value, onChange, min, max, ...props }: DateFieldProps) {
  const locale = useOwbLocale();
  return (
    <DatePicker
      {...props}
      locale={locale === "en" ? enUS : zhCN}
      format={DATE_FORMAT}
      value={calendarDate(value)}
      minDate={calendarDate(min) ?? undefined}
      maxDate={calendarDate(max) ?? undefined}
      allowClear
      onChange={(date) => onChange(date?.format(DATE_FORMAT) ?? "")}
    />
  );
}

export type DateTimeRange = [string | undefined, string | undefined];

export interface DateTimeRangeFieldProps extends FieldProps {
  value: DateTimeRange;
  onChange: (value: DateTimeRange) => void;
}

function timestamp(value?: string): Dayjs | null {
  if (!value) return null;
  const date = dayjs(value);
  return date.isValid() ? date : null;
}

/** Display local time and return ISO timestamps so filters compare instants. */
export function DateTimeRangeField({ value, onChange, ...props }: DateTimeRangeFieldProps) {
  const locale = useOwbLocale();
  return (
    <DatePicker.RangePicker
      {...props}
      locale={locale === "en" ? enUS : zhCN}
      format={DATE_TIME_FORMAT}
      showTime
      allowClear
      allowEmpty={[true, true]}
      value={[timestamp(value[0]), timestamp(value[1])]}
      onChange={(dates) => onChange([dates?.[0]?.toISOString(), dates?.[1]?.toISOString()])}
    />
  );
}
