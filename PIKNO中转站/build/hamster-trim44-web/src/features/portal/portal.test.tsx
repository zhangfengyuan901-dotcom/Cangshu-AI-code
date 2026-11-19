import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PortalApp } from "./app";
import {
  filterPublishedModels,
  modelCodeExample,
  publishedCatalog,
  readPublishedCatalog,
} from "./catalog";
import { accountPanel, portalPage } from "./route";

const image = {
  id: "pikno-image-synthetic",
  name: "Synthetic Image",
  kind: "image",
  resolutions: ["1024x1024"],
  ratios: ["1:1"],
  durations: [],
  max_images: 2,
  max_videos: 0,
  max_audio: 0,
  max_media_total: 2,
  prices: [{ resolution: "1024x1024", unit: "image", retail_cny: 0.012345 }],
};
const video = {
  id: "pikno-video-synthetic",
  name: "Synthetic Video",
  kind: "video",
  resolutions: ["720p"],
  ratios: ["16:9"],
  durations: [5],
  max_images: 3,
  max_videos: 1,
  max_audio: 1,
  max_media_total: 4,
  reference_surcharge_cny: 0.2,
  prices: [{ resolution: "720p", unit: "second", retail_cny: 0.123456 }],
};
const payload = (models: unknown[] = [image, video]) => ({
  success: true,
  data: { revision: "synthetic-revision", models },
});
function mount(path: string) {
  return render(
    <TooltipProvider>
      <PortalApp path={path} />
    </TooltipProvider>,
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

describe("PIKNO public portal boundaries", () => {
  it("separates public pages, console panels and internal administration", () => {
    expect(portalPage("/")).toBe("home");
    expect(portalPage("/hub/pricing/")).toBe("pricing");
    expect(portalPage("/hub/keys")).toBe("dashboard");
    for (const path of [
      "/channels",
      "/line-management",
      "/catalog-admin",
      "/account-lite/index.html",
      "/playground",
      "/v1/videos",
    ]) {
      expect(portalPage(path)).toBeUndefined();
    }
    expect(accountPanel("/hub/billing")).toBe("topup");
    expect(accountPanel("/hub/usage")).toBe("usage");
  });

  it("copies published customer fields while excluding private metadata and invalid prices", () => {
    const result = publishedCatalog(
      payload([
        {
          ...video,
          provider: "private-provider",
          secret: "private-sentinel",
          prices: [
            ...video.prices,
            { resolution: "720p", unit: "second", retail_cny: -1, cost_cny: 99 },
          ],
        },
        { ...image, id: "invalid/id" },
        video,
      ]),
    );
    expect(result.models).toHaveLength(1);
    expect(result.models[0].prices).toEqual(video.prices);
    expect(result.models[0].max_media_total).toBe(4);
    expect(result.models[0].reference_surcharge_cny).toBe(0.2);
    expect(JSON.stringify(result).includes("private-sentinel")).toBe(false);
    expect(JSON.stringify(result).includes("cost_cny")).toBe(false);
    expect(JSON.stringify(result).includes("provider")).toBe(false);
    const models = publishedCatalog(payload()).models;
    expect(filterPublishedModels(models, "IMAGE", "all", "all")).toHaveLength(1);
    expect(filterPublishedModels(models, "", "video", "720p")).toHaveLength(1);
    expect(filterPublishedModels(models, "", "image", "720p")).toHaveLength(0);
  });

  it("reads only the public catalogue without browser credentials and hides response errors", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(payload()));
    vi.stubGlobal("fetch", fetcher);
    await readPublishedCatalog();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/pikno/catalog",
      expect.objectContaining({ credentials: "omit", cache: "no-store" }),
    );
    fetcher.mockResolvedValue(Response.json({ error: "private-upstream-detail" }, { status: 503 }));
    await expect(readPublishedCatalog()).rejects.toThrow("catalog_unavailable");
  });

  it("searches actual published models and opens specifications with total limits and surcharge", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(payload()));
    vi.stubGlobal("fetch", fetcher);
    mount("/hub/models");
    await screen.findByText("Synthetic Video");
    fireEvent.change(screen.getByRole("textbox", { name: "Search models" }), {
      target: { value: "video" },
    });
    expect(screen.queryByText("Synthetic Image")).not.toBeInTheDocument();
    expect(screen.getByText("¥0.123456", { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View model" }));
    const details = await screen.findByRole("dialog");
    expect(details).toBeInTheDocument();
    expect(within(details).getByText("Total reference limit")).toBeInTheDocument();
    expect(within(details).getByText(/Published reference surcharge/)).toBeInTheDocument();
    expect(within(details).getByText("4")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Read API documentation" })).toHaveAttribute(
      "href",
      "/hub/docs",
    );
    expect(fetcher.mock.calls.every(([url]) => url === "/api/pikno/catalog")).toBe(true);
  });

  it("shows the supplied model animations with static reduced-motion and backdrop images", async () => {
    const artwork = [
      ["pikno-image-flare", "image-generation-v1", 550, 309],
      ["pikno-tool-depth", "depth-video-v1", 358, 358],
      ["pikno-tool-digital", "digital-human-v1", 478, 358],
      ["pikno-video-cs-dongguanewr", "anime-screen-heart-v1", 414, 230],
      ["pikno-video-cs-guankeling4", "magic-outfit-v1", 252, 252],
      ["pikno-video-cs-juzi_pool", "screen-like-v1", 357, 358],
      ["pikno-video-cs-ningmeng_c_pool", "cinematic-portrait-v1", 358, 358],
      ["pikno-video-cs-xigua2_pool", "sunset-dewdrop-v1", 262, 146],
    ] as const;
    const models = artwork.map(([id]) => ({
      ...(id === "pikno-image-flare" ? image : video),
      id,
      name: `Synthetic ${id}`,
    }));
    const fetcher = vi.fn().mockResolvedValue(Response.json(payload(models)));
    vi.stubGlobal("fetch", fetcher);
    const { container } = mount("/hub/models");
    await screen.findByText("Synthetic pikno-image-flare");
    expect(container.querySelectorAll(".portal-model-animation")).toHaveLength(8);
    for (const [id, file, width, height] of artwork) {
      const card = screen.getByText(id, { selector: "code" }).closest("[data-slot=card]");
      const image = card?.querySelector(".portal-model-animation");
      const poster = `/portal-artwork/models/${file}-poster.webp`;
      expect(image).toHaveAttribute("src", `/portal-artwork/models/${file}.gif`);
      expect(image).toHaveAttribute("alt", "");
      expect(image).toHaveAttribute("loading", "lazy");
      expect(image).toHaveAttribute("width", String(width));
      expect(image).toHaveAttribute("height", String(height));
      expect(card?.querySelector(".portal-model-artwork")).toHaveAttribute("aria-hidden", "true");
      expect(card?.querySelector("picture source")).toHaveAttribute(
        "media", "(prefers-reduced-motion: reduce)",
      );
      expect(card?.querySelector("picture source")).toHaveAttribute("srcset", poster);
      expect(card?.querySelector(".portal-model-artwork-backdrop")).toHaveAttribute("src", poster);
    }
    expect(fetcher.mock.calls.every(([url]) => url === "/api/pikno/catalog")).toBe(true);
  });

  it("keeps category fallbacks in model cards without replacing the home hero or shared artwork", async () => {
    const models = [
      { ...image, id: "future-image" },
      { ...video, id: "future-video" },
      { ...video, id: "pikno-tool-future", name: "Synthetic Tool" },
      { ...video, id: "constructor", name: "Synthetic Constructor" },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload(models))));
    const library = mount("/hub/models");
    await screen.findByText("Synthetic Tool");
    for (const [id, file] of [
      ["future-image", "image-generation-v1"],
      ["future-video", "sunset-dewdrop-v1"],
      ["pikno-tool-future", "digital-human-v1"],
      ["constructor", "sunset-dewdrop-v1"],
    ]) {
      const card = screen.getByText(id, { selector: "code" }).closest("[data-slot=card]");
      expect(card?.querySelector(".portal-model-animation")).toHaveAttribute(
        "src", `/portal-artwork/models/${file}.gif`,
      );
    }
    library.unmount();
    const home = mount("/");
    expect(home.container.querySelector(".portal-hero-poster")).toHaveAttribute(
      "src", "/portal-media/hero-poster-v1.webp",
    );
    expect(home.container.querySelector(".portal-model-artwork")).toBeNull();
    expect(home.container.querySelector('[data-artwork="image"]')).toHaveAttribute(
      "src", "/portal-artwork/image-v1.webp",
    );
  });

  it("renders exact CNY prices and no invented discount or substitute price", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json(payload([image, { ...video, prices: [] }]))),
    );
    mount("/hub/pricing");
    await screen.findByText("Synthetic Image");
    expect(screen.getByText("¥0.012345", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Pricing is not published for this model.")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByText(/-70%|discount/i)).not.toBeInTheDocument();
  });

  it("shows usage billing for images that advertise the new mode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload([{ ...image, image_billing: "usage-v1" }, video]))));
    mount("/hub/pricing");
    expect(await screen.findByText("Usage-based billing")).toBeInTheDocument();
    expect(screen.queryByText("¥0.012345", { exact: false })).toBeNull();
    expect(screen.getByText("¥0.123456", { exact: false })).toBeInTheDocument();
  });

  it("removes a selected model after a published-directory revision without issuing a task", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    let current = payload();
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json(current)));
    vi.stubGlobal("fetch", fetcher);
    const listeners = new Map<string, (event: { data: string }) => void>();
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener(name: string, listener: (event: { data: string }) => void) {
          listeners.set(name, listener);
        }
        close() {}
      },
    );
    await act(async () => {
      mount("/hub/models");
    });
    fireEvent.click(screen.getAllByRole("button", { name: "View model" })[0]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    current = payload([]);
    act(() => {
      listeners.get("catalog-change")?.({ data: JSON.stringify({ revision: "a".repeat(64) }) });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2300);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Synthetic Image")).not.toBeInTheDocument();
    expect(fetcher.mock.calls.every(([url]) => url === "/api/pikno/catalog")).toBe(true);
  });

  it("does not substitute example models or raw errors when the catalogue read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(Response.json({ error: "private-upstream-detail" }, { status: 503 })),
    );
    mount("/hub/models");
    await screen.findByText("Unable to load model catalog");
    expect(screen.queryByText("Synthetic Image")).not.toBeInTheDocument();
    expect(document.body.textContent?.includes("private-upstream-detail")).toBe(false);
  });

  it("keeps documentation copy-only and all examples read-only", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    mount("/hub/docs");
    expect(screen.getByRole("link", { name: "Full API reference" })).toHaveAttribute(
      "href",
      "/api-guide.md",
    );
    for (const language of ["curl", "node", "python"] as const) {
      const code = modelCodeExample(undefined, language);
      expect(code.includes("/v1/models")).toBe(true);
      expect(code.includes("/v1/videos")).toBe(false);
      expect(code.includes("POST")).toBe(false);
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /generate|run|submit|execute/i }),
    ).not.toBeInTheDocument();
  });

  it("reuses fixed account pages and accepts only bounded size messages from that same-origin frame", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    mount("/hub/keys");
    const frame = screen.getByTitle("PIKNO account management") as HTMLIFrameElement;
    expect(frame).toHaveAttribute("src", "/account-lite/index.html?tab=keys&embed=1");
    const send = (origin: string, source: Window | null, height: number) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin,
          source,
          data: { type: "pikno-account-size", height },
        }),
      );
    act(() => send("https://foreign.invalid", frame.contentWindow, 1400));
    expect(frame.style.height).toBe("800px");
    act(() => send(location.origin, window, 1400));
    expect(frame.style.height).toBe("800px");
    act(() => send(location.origin, frame.contentWindow, 999999));
    expect(frame.style.height).toBe("800px");
    act(() => send(location.origin, frame.contentWindow, 1400));
    await waitFor(() => expect(frame.style.height).toBe("1400px"));
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("passes a desktop registration flow to the account frame and removes it from the address", () => {
    const flow = "A".repeat(43);
    history.replaceState(null, "", `/hub/billing#desktop=${flow}`);
    mount("/hub/billing");
    expect(screen.getByTitle("PIKNO account management")).toHaveAttribute(
      "src", `/account-lite/index.html?tab=topup&embed=1#desktop=${flow}`,
    );
    expect(sessionStorage.getItem("hamster-desktop-flow")).toBe(flow);
    expect(location.hash).toBe("");
  });
  it("invalid desktop links cannot restore an older account flow", () => {
    sessionStorage.setItem("hamster-desktop-flow", "B".repeat(43));
    history.replaceState(null, "", "/hub/billing#desktop=invalid");
    mount("/hub/billing");
    expect(screen.getByTitle("PIKNO account management")).toHaveAttribute(
      "src", "/account-lite/index.html?tab=topup&embed=1#desktop=invalid",
    );
    expect(sessionStorage.getItem("hamster-desktop-flow")).toBeNull();
  });
});
