import { expect, test } from "bun:test";
import type { FFmpeg } from "@ffmpeg/ffmpeg";

import { remuxDirectorWebmWithFactory } from "@/lib/canvas/director/director-webm-remux";

function makeFFmpeg(exitCode = 0) {
    const writes: string[] = [];
    const reads: string[] = [];
    const deletes: string[] = [];
    const commands: string[][] = [];
    let terminated = 0;
    const ffmpeg = {
        writeFile: async (name: string) => { writes.push(name); },
        exec: async (args: string[]) => { commands.push(args); return exitCode; },
        readFile: async (name: string) => { reads.push(name); return new Uint8Array([1, 2, 3]); },
        deleteFile: async (name: string) => { deletes.push(name); },
        terminate: () => { terminated += 1; },
    } as unknown as FFmpeg;
    return { ffmpeg, writes, reads, deletes, commands, terminated: () => terminated };
}

test("Director WebM is remuxed with stream copy in isolated temporary files and worker cleanup", async () => {
    const fake = makeFFmpeg();
    const result = await remuxDirectorWebmWithFactory(new Blob([new Uint8Array([7])], { type: "video/webm" }), async () => fake.ffmpeg);

    expect(result.type).toBe("video/webm");
    expect(result.size).toBe(3);
    expect(fake.writes).toHaveLength(1);
    expect(fake.reads).toEqual([fake.writes[0].replace("input", "output")]);
    expect(fake.commands[0]).toContain("-c");
    expect(fake.commands[0]).toContain("copy");
    expect(fake.commands[0]).toContain("-map");
    expect(fake.deletes.sort()).toEqual([...fake.writes, ...fake.reads].sort());
    expect(fake.terminated()).toBe(1);
});

test("Director WebM remux refuses a failed FFmpeg operation and still cleans up", async () => {
    const fake = makeFFmpeg(1);
    await expect(remuxDirectorWebmWithFactory(new Blob([new Uint8Array([7])], { type: "video/webm" }), async () => fake.ffmpeg))
        .rejects.toThrow("无损封装失败");
    expect(fake.deletes).toHaveLength(2);
    expect(fake.terminated()).toBe(1);
});
