/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

For commercial licensing, please contact support@quantumnous.com
*/
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { PublicLayout } from "@/components/layout";
import { Footer } from "@/components/layout/components/footer";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";

const TRUST_POINTS = ["Unified endpoint", "Usage-based billing", "Live usage records"] as const;

const CAPABILITIES = [
  {
    index: "01",
    title: "One API",
    copy: "A consistent request format across supported model services.",
  },
  {
    index: "02",
    title: "Clear pricing",
    copy: "Review model prices and usage before scaling your workflow.",
  },
  {
    index: "03",
    title: "Operational control",
    copy: "Tokens, permissions, and request records stay in one place.",
  },
] as const;

export function Home() {
  const { t } = useTranslation();
  const authUser = useAuthStore((state) => state.auth.user);
  const isAuthenticated = Boolean(authUser);

  return (
    <PublicLayout showMainContainer={false}>
      <main className="pikno-home">
        <section className="pikno-home__hero">
          <div className="pikno-home__copy">
            <p className="pikno-home__eyebrow">仓鼠AI · 账户与模型服务</p>
            <h1>{t("One gateway. Every creative possibility.")}</h1>
            <p className="pikno-home__lead">
              {t(
                "A unified API for image, video, and general-purpose models. Clear pricing, stable routing, and usage records you can review at any time.",
              )}
            </p>
            <div className="pikno-home__actions">
              <Button
                className="pikno-home__primary-action"
                render={<Link to={isAuthenticated ? "/dashboard" : "/sign-in"} />}
              >
                {isAuthenticated ? t("Go to Dashboard") : t("Sign in")}
              </Button>
              <Button
                variant="outline"
                className="pikno-home__secondary-action"
                render={<Link to="/pricing" />}
              >
                {t("View Pricing")}
              </Button>
            </div>
            <ul className="pikno-home__trust" aria-label={t("Core Features")}>
              {TRUST_POINTS.map((item) => (
                <li key={item}>{t(item)}</li>
              ))}
            </ul>
          </div>

          <div className="pikno-home__brand-panel" aria-label="仓鼠AI">
            <div className="pikno-home__halo" aria-hidden="true" />
            <img src="/hamster-mark.png" alt="" width="128" height="128" className="pikno-home__mark" />
            <div className="pikno-home__wordmark">仓鼠AI</div>
            <div className="pikno-home__descriptor">AI MODEL GATEWAY</div>
            <div className="pikno-home__signal" aria-hidden="true">
              <span>API</span>
              <span>IMAGE</span>
              <span>VIDEO</span>
            </div>
          </div>
        </section>

        <section className="pikno-home__capabilities">
          {CAPABILITIES.map((item) => (
            <article key={item.index}>
              <span>{item.index}</span>
              <h2>{t(item.title)}</h2>
              <p>{t(item.copy)}</p>
            </article>
          ))}
        </section>

        <p className="pikno-home__signature">仓鼠AI · {t("Create beyond imagination.")}</p>
      </main>
      <Footer />
    </PublicLayout>
  );
}
