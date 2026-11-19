/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { createInstance } from "i18next";
import { expect, it } from "vitest";

import en from "@/i18n/locales/en.json";
import zhTW from "@/i18n/locales/zh-TW.json";
import zhCN from "@/i18n/locales/zh.json";

it.each([
  ["en", "Upstream connections", "All connections", "By supplier"],
  ["zhCN", "上游连接", "全部连接", "按供应商分类"],
  ["zhTW", "上游連線", "全部連線", "按供應商分類"],
])("loads the final built supplier language resources in %s", async (lng, title, all, grouped) => {
  const instance = createInstance();
  await instance.init({ lng, resources: { en, zhCN, zhTW }, fallbackLng: "en", initAsync: false });
  expect(instance.t("Upstream connections")).toBe(title);
  expect(instance.t("All connections")).toBe(all);
  expect(instance.t("By supplier")).toBe(grouped);
  if (lng !== "en") {
    expect(instance.t("Supplier labels")).not.toBe("Supplier labels");
    for (const key of [
      "Manage upstream API Keys by supplier label. Customer access still uses image-standard and video-standard.",
      "Add a supplier label to group a connection here. New or unlabeled connections remain available in All connections.",
    ]) {
      expect(instance.t(key)).not.toBe(key);
    }
  }
});
