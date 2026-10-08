import { AxonModelCenter } from "./axon-model-center";

type ModelSetupView = "quick" | "channels" | "models";

export function ModelSetupPane(_props: { view: ModelSetupView; onViewChange: (view: ModelSetupView) => void }) {
    return <AxonModelCenter />;
}
