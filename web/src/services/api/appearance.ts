import { http } from "@/services/api/request";
import type { SkinDefinition } from "@/lib/skin-themes";

export type PublicAppearance = {
    schemaVersion: number;
    brandName: string;
    brandSlug: string;
    logoUrl: string;
    darkLogoUrl: string;
    logoFrameEnabled: boolean;
    skinId: string;
    activeSkin: SkinDefinition;
    seoTitle: string;
    seoDescription: string;
    seoKeywords: string;
    footerCopyright: string;
    icpFilingEnabled: boolean;
    icpFilingNumber: string;
    logoConfigured: boolean;
    darkLogoConfigured: boolean;
    configured: boolean;
    revision: string;
    updatedAt?: string;
};

export async function getPublicAppearance(signal?: AbortSignal) {
    const result = await http.get<{ appearance: PublicAppearance }>("/public/appearance", { signal });
    return result.appearance;
}
