import { expect, test } from "bun:test";
import { zipSync } from "fflate";

import { createZip, readZip } from "../src/lib/zip";

test("ZIP 流式读取保留项目文件", async () => {
    const archive = await createZip([
        { name: "projects.json", data: "{\"version\":4}" },
        { name: "projects/example/files/image.png", data: new Uint8Array([1, 2, 3]) },
    ]);
    const files = await readZip(archive, { maxEntries: 2, maxEntryBytes: 64, maxTotalBytes: 128 });
    expect(await files.get("projects.json")?.text()).toBe('{"version":4}');
    expect(new Uint8Array(await files.get("projects/example/files/image.png")!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
});

test("ZIP 解压在展开大小超过限额时停止", async () => {
    const bomb = new Blob([zipSync({ "bomb.txt": new Uint8Array(2 * 1024 * 1024).fill(65) }, { level: 9 })]);
    expect(bomb.size).toBeLessThan(100_000);
    await expect(readZip(bomb, { maxEntries: 2, maxEntryBytes: 100_000, maxTotalBytes: 100_000 })).rejects.toThrow(/过大|超过允许大小/);
});

test("ZIP 解压拒绝过多条目", async () => {
    const archive = await createZip([{ name: "a", data: "a" }, { name: "b", data: "b" }]);
    await expect(readZip(archive, { maxEntries: 1 })).rejects.toThrow(/条目过多/);
});
