// A full panel model for view, key and component tests.

import { buildPanelModel, type PanelModel } from "../../src/panel/model.ts";
import { basicEvents, files, latest, revisionFile, settingsFixture, snapshotFile } from "./fixtures.ts";

export function richModel(): PanelModel {
	return buildPanelModel(files({
		events: basicEvents,
		state: { version: 1, enabled: true, revision: 2 },
		snapshot: snapshotFile,
		revisions: new Map([[1, revisionFile]]),
	}), { latest: latest(7000, 6), settings: settingsFixture });
}
