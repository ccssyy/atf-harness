// R2.6(D240)锚:字段卡自由文本解析单源(parseFieldChoiceInput)——尾巴归一+排除语义+正面枚举。
// 黑盒实锚(复验#24):「除 X 外的 N 个都要」被旧正则静默吞(卡消失凭据不落)。
import { describe, expect, it } from "vitest";
import { parseFieldChoiceInput } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

const KNOWN = new Set([
  "flight_number", "shipper", "consignee", "awb_date", "awb_title",
  "airport_of_departure", "airport_of_destination", "issuer",
  "wt_val_payment", "shipper_signature", "carrier_signature", "hawb",
  "awb", "freight_payment_terms", "notify_party", "carrier_agent_signature",
  "mawb",
]);

describe("R2.6 字段卡自由文本解析(D240 防回潮)", () => {
  it("排除语义裸形态:「除了 awb_title」→ 16 字段", () => {
    const got = parseFieldChoiceInput("除了 awb_title", KNOWN);
    expect(got).toHaveLength(16);
    expect(got).not.toContain("awb_title");
  });

  it("尾巴形态:「除 awb_title 外的 16 个都要」→ 16 字段(旧正则静默吞的形态)", () => {
    const got = parseFieldChoiceInput("除 awb_title 外的 16 个都要", KNOWN);
    expect(got).toHaveLength(16);
    expect(got).not.toContain("awb_title");
  });

  it("尾巴形态:「不要 awb_title，其他都要」→ 16 字段", () => {
    const got = parseFieldChoiceInput("不要 awb_title，其他都要", KNOWN);
    expect(got).toHaveLength(16);
  });

  it("正面枚举:「awb, shipper」→ 两字段", () => {
    expect(parseFieldChoiceInput("awb, shipper", KNOWN)).toEqual(["awb", "shipper"]);
  });

  it("解析失败返回空数组(fail-loud 信号,调用方追问不落账)", () => {
    expect(parseFieldChoiceInput("随便来点", KNOWN)).toEqual([]);
    expect(parseFieldChoiceInput("除 awb_title 和不存在的字段", KNOWN)).toEqual([]);
  });
});
