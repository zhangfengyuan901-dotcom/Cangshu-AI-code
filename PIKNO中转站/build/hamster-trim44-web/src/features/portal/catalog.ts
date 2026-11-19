export interface PublishedPrice {
  resolution: string;
  unit: "image" | "second" | "request";
  retail_cny: number;
}

export interface PublishedModel {
  id: string;
  name: string;
  kind: "image" | "video";
  category: "image" | "video" | "tool";
  resolutions: string[];
  ratios: string[];
  durations: number[];
  max_images: number;
  max_videos: number;
  max_audio: number;
  max_media_total?: number;
  reference_surcharge_cny?: number;
  image_billing?: "usage-v1";
  prices: PublishedPrice[];
}

export interface PublishedCatalog {
  revision: string;
  models: PublishedModel[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.length <= 80)
        .slice(0, 100)
    : [];
const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1000
    ? value
    : 0;

// Copy only published customer fields. Provider credentials, cost and raw errors never enter portal state.
export function publishedCatalog(value: unknown): PublishedCatalog {
  if (!record(value) || !record(value.data) || !Array.isArray(value.data.models)) {
    throw new Error("catalog_unavailable");
  }
  const models: PublishedModel[] = [];
  const seen = new Set<string>();
  for (const item of value.data.models) {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      !/^[a-zA-Z0-9._:-]{1,160}$/.test(item.id) ||
      seen.has(item.id) ||
      typeof item.name !== "string" ||
      item.name.length > 160 ||
      !["image", "video"].includes(String(item.kind))
    ) {
      continue;
    }
    seen.add(item.id);
    const prices: PublishedPrice[] = [];
    for (const price of Array.isArray(item.prices) ? item.prices : []) {
      if (
        !record(price) ||
        typeof price.resolution !== "string" ||
        price.resolution.length > 80 ||
        !["image", "second", "request"].includes(String(price.unit))
      ) {
        continue;
      }
      let amount = Number.NaN;
      if (typeof price.retail_cny === "number") {
        amount = price.retail_cny;
      } else if (
        typeof price.retail_cny === "string" &&
        /^\d+(?:\.\d{1,6})?$/.test(price.retail_cny)
      ) {
        amount = Number(price.retail_cny);
      }
      if (!Number.isFinite(amount) || amount < 0) continue;
      prices.push({
        resolution: price.resolution,
        unit: price.unit as PublishedPrice["unit"],
        retail_cny: amount,
      });
    }
    let surcharge: number | undefined;
    if (typeof item.reference_surcharge_cny === "number") {
      surcharge = item.reference_surcharge_cny;
    } else if (
      typeof item.reference_surcharge_cny === "string" &&
      /^\d+(?:\.\d{1,6})?$/.test(item.reference_surcharge_cny)
    ) {
      surcharge = Number(item.reference_surcharge_cny);
    }
    models.push({
      id: item.id,
      name: item.name,
      kind: item.kind as PublishedModel["kind"],
      category: item.id.startsWith("pikno-tool-") ? "tool" : (item.kind as "image" | "video"),
      resolutions: strings(item.resolutions),
      ratios: strings(item.ratios),
      durations: Array.isArray(item.durations)
        ? item.durations
            .filter(
              (v): v is number =>
                typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 86400,
            )
            .slice(0, 100)
        : [],
      max_images: count(item.max_images),
      max_videos: count(item.max_videos),
      max_audio: count(item.max_audio),
      ...(typeof item.max_media_total === "number" &&
      Number.isSafeInteger(item.max_media_total) &&
      item.max_media_total >= 0
        ? { max_media_total: item.max_media_total }
        : {}),
      ...(surcharge !== undefined && Number.isFinite(surcharge) && surcharge >= 0
        ? { reference_surcharge_cny: surcharge }
        : {}),
      ...(item.kind === "image" && item.image_billing === "usage-v1"
        ? { image_billing: "usage-v1" }
        : {}),
      prices,
    });
  }
  return {
    revision: typeof value.data.revision === "string" ? value.data.revision.slice(0, 160) : "",
    models,
  };
}

export async function readPublishedCatalog(signal?: AbortSignal): Promise<PublishedCatalog> {
  const response = await fetch("/api/pikno/catalog", {
    credentials: "omit",
    cache: "no-store",
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("catalog_unavailable");
  return publishedCatalog(await response.json());
}

export function filterPublishedModels(
  models: PublishedModel[],
  search: string,
  category: string,
  resolution: string,
): PublishedModel[] {
  const query = search.trim().toLowerCase();
  return models.filter(
    (model) =>
      (category === "all" || model.category === category) &&
      (resolution === "all" || model.resolutions.includes(resolution)) &&
      (!query || `${model.name} ${model.id}`.toLowerCase().includes(query)),
  );
}

// Documentation is text only. The browser never runs these customer-side examples.
export function modelCodeExample(
  model?: PublishedModel,
  language: "curl" | "node" | "python" = "curl",
): string {
  const note = model ? `# Model: ${model.id}\n` : "";
  if (language === "node") {
    return `${note.replace("#", "//")}const response = await fetch('https://www.piknoai.com/v1/models', {\n  headers: { Authorization: \`Bearer \${process.env.PIKNO_API_KEY}\` }\n});\nconst models = await response.json();\nconsole.log(models);`;
  }
  if (language === "python") {
    return `${note}import os\nimport requests\n\nresponse = requests.get(\n    'https://www.piknoai.com/v1/models',\n    headers={'Authorization': 'Bearer ' + os.environ['PIKNO_API_KEY']}\n)\nresponse.raise_for_status()\nprint(response.json())`;
  }
  return `${note}curl https://www.piknoai.com/v1/models \\\n  -H "Authorization: Bearer $PIKNO_API_KEY"`;
}
