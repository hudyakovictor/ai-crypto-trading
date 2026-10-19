import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin", "cyrillic"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "OKX Quant Hypotheses Lab — Исследовательский терминал",
  // Публичное описание не обещает доходности: раньше в metadata стоял «трек к
  // цели +$15 000», то есть страница в поисковой выдаче и в превью соцсетей
  // рекламировала прибыль, которой у бумажного журнала нет и быть не может.
  description:
    "Автономная бумажная лаборатория количественных гипотез на котировках OKX: 15 категорий сигналов, прогноз в БД, проверка через 15 минут реальными котировками, обучение весов на накопленных исходах. Без ордеров на биржу и без обещаний доходности.",
};

export const viewport: Viewport = {
  themeColor: "#06090f",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" className={`${inter.variable} ${jetbrains.variable}`}>
      <body>{children}</body>
    </html>
  );
}
