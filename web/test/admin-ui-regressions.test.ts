import { expect, test } from "bun:test";

function compactSource(source: string) {
    return source.replace(/\s+/g, " ").trim();
}

function sourceSection(source: string, startMarker: string, endMarker: string) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
}

test("announcement editor preserves image and pinned fields through edit and save", async () => {
    const [panelSource, safetySource] = await Promise.all([
        Bun.file(new URL("../src/pages/admin/components/admin-announcements-panel.tsx", import.meta.url)).text(),
        Bun.file(new URL("../src/pages/admin/components/admin-announcement-safety.ts", import.meta.url)).text(),
    ]);
    const panel = compactSource(panelSource);

    expect(panel).toContain("uploadAdminAnnouncementImage");
    expect(panel).toContain("discardAdminAnnouncementImage");
    expect(panel).toContain('imageResourceId: announcement.imageResourceId || ""');
    expect(panel).toContain("pinned: announcement.pinned");
    expect(panel).toContain('imageResourceId: values.imageResourceId?.trim() || ""');
    expect(panel).toContain("pinned: Boolean(values.pinned)");
    expect(panel).toContain('(announcement?.imageResourceId || "") === (expectedContent.imageResourceId || "")');
    expect(panel).toContain('rootClassName="admin-modal-root admin-announcement-editor-modal"');
    expect(panel).toContain("centered");
    expect(panel).not.toContain("<Drawer");
    expect(safetySource).toContain("imageResourceId?: string");
    expect(safetySource).toContain("pinned?: boolean");
});

test("plugin upload owns native drops and price availability text remains readable", async () => {
    const pluginSource = await Bun.file(new URL("../src/pages/plugins/plugin-documentation-modals.tsx", import.meta.url)).text();
    expect(pluginSource).toContain("event.preventDefault()");
    expect(pluginSource).toContain("onDragOver={(event)");
    expect(pluginSource).toContain("onDrop={handlePluginDrop}");
    expect(pluginSource).toContain("点击选择插件文件，也可拖拽到此处");
    expect(pluginSource).toContain("释放文件以上传插件");
    expect(pluginSource).toContain("isDraggingPlugin");
});

test("model reference limits use compact rows only inside the admin editor", async () => {
    const css = await Bun.file(new URL("../src/styles/admin-ui.css", import.meta.url)).text();
    const numberField = sourceSection(css, ".admin-model-editor-references .admin-capability-number-field {", ".admin-model-editor-references .admin-capability-boolean-field {");
    expect(numberField).toContain("grid-template-columns: minmax(0, 1fr) 80px;");
    expect(numberField).toContain("min-height: 32px;");
    expect(numberField).toContain("align-items: center;");
    const switches = sourceSection(css, ".admin-model-editor-references .admin-capability-boolean-field label {", "@media (min-width: 601px)");
    expect(switches).toContain("display: flex;");
    const referenceGrid = sourceSection(css, ".admin-model-editor-references .admin-capability-reference-grid {", ".admin-model-editor-references .admin-capability-number-field {");
    expect(referenceGrid).toContain("align-items: start;");
    expect(compactSource(css)).toContain(".admin-model-editor-modal .admin-capability-reference-grid { grid-template-columns: minmax(0, 1fr);");
});

test("model editor presents protocols in a searchable inline radio browser instead of a dropdown", async () => {
    const [source, css] = await Promise.all([Bun.file(new URL("../src/pages/admin/components/channel-model-editor.tsx", import.meta.url)).text(), Bun.file(new URL("../src/styles/admin-ui.css", import.meta.url)).text()]);
    const protocolSection = sourceSection(compactSource(source), '<Form.Item className="admin-model-protocol-field"', "{protocolError && (");

    expect(protocolSection).toContain("<ModelProtocolBrowser");
    expect(protocolSection).not.toContain("<Select");
    expect(compactSource(css)).toContain(".admin-model-protocol-field { grid-column: 1 / -1;");
});

test("channel model fetch requires explicit selection before import", async () => {
    const [componentSource, apiSource, adminCssSource] = await Promise.all([
        Bun.file(new URL("../src/pages/admin/components/channel-model-manager.tsx", import.meta.url)).text(),
        Bun.file(new URL("../src/services/api/channel-models.ts", import.meta.url)).text(),
        Bun.file(new URL("../src/styles/admin-ui.css", import.meta.url)).text(),
    ]);
    const component = compactSource(componentSource);

    expect(apiSource).toContain("http.post<{ models: string[] }>(`/admin/channels/${encodeURIComponent(channelId)}/models/fetch`)");
    expect(apiSource).toContain("http.post<{ models: string[]; added: number }>(`/admin/channels/${encodeURIComponent(channelId)}/models/import`, { models })");
    expect(component).toContain('title="选择要导入的模型"');
    expect(component).toContain("默认已全选");
    expect(component).toContain("setFetchPreviewOpen(true)");
    expect(component).toContain("setSelectedFetchModels(result.models)");
    expect(component).toContain("已选择 {selectedFetchModels.length} / {fetchPreviewModels.length} 个模型");
    expect(component).toContain("disabled={importing || allFetchModelsSelected}");
    expect(component).toContain("onClick={() => setSelectedFetchModels(fetchPreviewModels)}");
    expect(component).toContain("disabled={importing || selectedFetchModels.length === 0}");
    expect(component).toContain("onClick={() => setSelectedFetchModels([])}");
    expect(component).toContain("取消全选");
    expect(component).toContain("disabled={importing}");
    expect(component).toContain("importAdminChannelModels(channel.id, selectedFetchModels)");
    expect(component).toContain("disabled={!selectedFetchModels.length}");
    expect(component).not.toContain("disabled: alreadyExists");
    expect(component).not.toContain("const result = await fetchAdminChannelModels(channel.id); await reload();");
    expect(adminCssSource).toContain(".admin-model-import-modal .channel-model-import-picker .ant-checkbox-checked");
    expect(adminCssSource).toContain("border-color: var(--control-check-fg) !important");
});

test("channel model manager supports bounded atomic batch deletion", async () => {
    const [componentSource, apiSource] = await Promise.all([Bun.file(new URL("../src/pages/admin/components/channel-model-manager.tsx", import.meta.url)).text(), Bun.file(new URL("../src/services/api/channel-models.ts", import.meta.url)).text()]);
    const component = compactSource(componentSource);

    expect(apiSource).toContain("http.post<{ deleted: number }>(`/admin/channels/${encodeURIComponent(channelId)}/models/batch-delete`, { modelIds })");
    expect(component).toContain("<AdminBatchBar count={selectedModelIds.length}");
    expect(component).toContain("rowSelection:");
    expect(component).toContain("selectedRowKeys: selectedModelIds");
    expect(component).toContain("preserveSelectedRowKeys: true");
    expect(component).toContain("setSelectedModelIds(next.slice(0, 100))");
    expect(component).toContain("deleteAdminChannelModels(channel.id, selectedModelIds)");
    expect(component).toContain("okButtonProps: { danger: true }");
    expect(component).toContain("本次就不会删除任何模型");
    expect(component).toContain("批量删除");
});

test("analytics keeps fixed range presets distinct and uses enabled channel models for pricing", async () => {
    const source = compactSource(await Bun.file(new URL("../src/pages/admin/components/analytics-panel.tsx", import.meta.url)).text());

    expect(source).toContain('type RangePreset = "7d" | "30d" | "60d"');
    expect(source).toContain('["60d", "60 天"]');
    expect(source).toContain('next.set("rangePreset", rangePreset)');
    expect(source).toContain("setRangePreset(undefined)");
});

test("system settings group only exposes the kept panels", async () => {
    const settings = await Bun.file(new URL("../src/pages/settings/index.tsx", import.meta.url)).text();

    expect(settings).toContain('{ key: "prompt-templates"');
    expect(settings).toContain('{ key: "features"');
    expect(settings).toContain('{ key: "drawing-engine"');
    expect(settings).toContain('{ key: "third-party"');
    // 存储资源、系统性能已下线，不再出现在设置导航里。
    expect(settings).not.toContain('{ key: "resources"');
    expect(settings).not.toContain('{ key: "system-performance"');
});

test("nested admin pages return to their own parent entry", async () => {
    const source = await Bun.file(new URL("../src/pages/admin/components/admin-shell.tsx", import.meta.url)).text();
    const compacted = compactSource(source);
    expect(compacted).toContain("const currentItem = currentSection?.items.find");
    // 面板允许调用方覆盖表头归属（设置页复用），未指定时仍回到自己的父级入口。
    expect(compacted).toContain("const sectionPath = section?.path ?? (back ? (currentItem?.path");
});

test("feature availability only exposes creative workspace switches", async () => {
    const source = await Bun.file(new URL("../src/pages/admin/components/feature-availability-panel.tsx", import.meta.url)).text();

    // 本地工作站已下线积分计费与前台模型目录，功能开放页不再暴露这两个开关。
    expect(source).not.toContain('title: "积分计费"');
    expect(source).not.toContain('title: "前台模型目录"');
    expect(source).not.toContain("FeatureSourceRow");

    // 创作相关开关保留，关闭短剧入口仍需二次确认。
    expect(source).toContain('title: "短剧创作"');
    expect(source).toContain('title: "任务中心"');
    expect(source).toContain('title: "自己的模型 API"');
    expect(source).toContain('title: "关闭短剧创作？"');
    expect(source).toContain("onChange={requestFeatureChange}");
});

test("admin settings use full-width summaries without selected-card side stripes", async () => {
    const [componentSource, cssSource] = await Promise.all([Bun.file(new URL("../src/pages/admin/components/admin-ui.tsx", import.meta.url)).text(), Bun.file(new URL("../src/styles/admin-ui.css", import.meta.url)).text()]);

    expect(componentSource).not.toContain("lg:grid lg:grid-cols-4");
    expect(cssSource).not.toContain('content: "配置摘要"');
    expect(cssSource).not.toContain("grid-template-columns: minmax(0, 1fr) 344px");
    expect(cssSource).not.toContain(".admin-storage-mode-choice::before");

    const featureSelected = sourceSection(cssSource, ".admin-feature-board-row.is-selected {", ".admin-feature-board-row.is-dirty {");
    const drawingSelected = sourceSection(cssSource, ".admin-drawing-engine-choice.is-selected {", ".admin-drawing-engine-choice.is-unavailable");
    expect(featureSelected).not.toContain("inset 3px 0 0");
    expect(drawingSelected).not.toContain("inset 3px 0 0");
});

test("admin tables keep requested filters and actions in the intended positions", async () => {
    const storageSource = await Bun.file(new URL("../src/pages/admin/components/storage-resources-panel.tsx", import.meta.url)).text();

    const storageToolbar = sourceSection(storageSource, "toolbar={", "toolbarActiveFilters=");
    expect(storageToolbar).toContain('className="admin-storage-resource-filters"');
    expect(storageToolbar).toContain('placeholder="资源 ID 或对象路径"');
    // 本地工作站只有一个账号，按用户 ID 筛选的输入框已下线。
    expect(storageToolbar).not.toContain('placeholder="用户"');
    expect(storageToolbar).toContain('aria-label="筛选资源类型"');
    expect(storageToolbar).toContain('aria-label="筛选资源状态"');
    expect(storageToolbar).toContain('aria-label="筛选存储类型"');
});

test("banner announcement editor keeps title styles through edit, save and status toggle", async () => {
    const [panelSource, editorSource, sliderSource, apiSource, contentSource, emojiPickerSource, noticeSource] = await Promise.all([
        Bun.file(new URL("../src/pages/admin/components/admin-banner-announcements-panel.tsx", import.meta.url)).text(),
        Bun.file(new URL("../src/pages/admin/components/banner-title-editor.tsx", import.meta.url)).text(),
        Bun.file(new URL("../src/components/layout/banner-announcements-slider.tsx", import.meta.url)).text(),
        Bun.file(new URL("../src/services/api/announcements.ts", import.meta.url)).text(),
        Bun.file(new URL("../src/components/layout/banner-announcement-content.tsx", import.meta.url)).text(),
        Bun.file(new URL("../src/pages/admin/components/banner-notice-emoji-picker.tsx", import.meta.url)).text(),
        Bun.file(new URL("../src/lib/announcements/banner-notice.ts", import.meta.url)).text(),
    ]);
    const panel = compactSource(panelSource);
    const slider = compactSource(sliderSource);

    // 状态开关与保存都必须带上样式分段与通知类型：后端更新走显式字段表，漏传会清空它们。
    expect(panel).toContain("titleRuns: banner.titleRuns");
    expect(panel).toContain("titleRuns: runs");
    expect(panel).toContain("noticeType: selectedNoticeType");
    expect(panel).toContain("noticeType: normalizeBannerNoticeType(banner.noticeType)");
    // 编辑入口不能被新建信号重置：父级 createOpen 消费后立即复位，编辑路径不再写回该标志。
    expect(panel).toContain("onCreateOpenChange(false)");
    expect(panel).toContain('setDialog({ mode: "edit", banner })');
    expect(panel).toContain("banner.titleRuns?.length");
    // AntD 6 用 destroyOnHidden，destroyOnClose 已废弃。
    expect(panel).toContain("destroyOnHidden");
    expect(panel).not.toContain("destroyOnClose");
    // Modal 渲染在 body portal 里，必须挂 admin-modal-root 才能拿到弹窗作用域的强边框 / 分层 token，
    // 否则编辑器等自绘控件的边框回落到 :root 的 8% 透明度，肉眼不可见。
    expect(panel).toContain('rootClassName="admin-modal-root"');
    // 非表单控件不能放进 Form.Item（会被注入 value/onChange/ref）。
    expect(panel).toContain("<BannerNoticePreview runs={titleRuns} hasLink={Boolean(linkValue?.trim())} noticeType={noticeType} />");
    // 通知类型在后台要有独立入口；emoji 图标不设独立字段，经编辑器「图标」按钮插入。
    expect(panel).toContain("<BannerNoticeTypeSelector");
    expect(panel).not.toContain("BannerNoticeIconPicker");
    expect(panel).not.toContain("normalizeBannerNoticeIcon");

    expect(editorSource).toContain("applyBannerTitleStyle");
    expect(editorSource).toContain("clearBannerTitleStyle");
    expect(editorSource).toContain("lowContrastBannerTitleColors");
    // 标题是单行语义，Enter 不产生新段落。
    expect(editorSource).toContain('event.key === "Enter"');
    // emoji 素材插到光标处、作为普通文本保存（无独立字段、无默认图标）。
    expect(editorSource).toContain("<BannerNoticeEmojiPopover");
    expect(editorSource).toContain("insertContent(emoji)");
    expect(editorSource).not.toContain("BannerAnnouncementIcon");
    // 预览必须走前台同一份展示单元，否则「预览即前台」不成立。
    expect(editorSource).toContain("bannerAnnouncementBarStyle(noticeType)");

    // 前台通知条必须按分段渲染，不能退回纯文本；底色来自当前通知的类型，标题前不再有固定图标。
    expect(sliderSource).toContain("BannerAnnouncementTitle");
    expect(sliderSource).toContain("currentBanner.titleRuns");
    expect(slider).toContain("bannerAnnouncementBarStyle(currentBanner.noticeType)");
    expect(slider).not.toContain("BannerAnnouncementIcon");
    expect(slider).not.toContain("notice-banner-surface");

    // 展示单元是唯一来源：底色、富文本标题、详情入口都在这里定义，前台与预览共用；
    // 图标素材是标题文本的一部分，展示单元不再单独处理图标。
    expect(contentSource).toContain("export function bannerAnnouncementBarStyle");
    expect(contentSource).toContain("export function BannerAnnouncementLinkHint");
    expect(contentSource).toContain("export function BannerAnnouncementTitle");
    expect(contentSource).not.toContain("BannerAnnouncementIcon");

    // emoji 面板：默认收起（Popover 点击触发），插入后不自动关闭，方便连续插入。
    expect(emojiPickerSource).toContain('trigger="click"');
    expect(emojiPickerSource).toContain('onPick(item.char)');
    expect(noticeSource).toContain("BANNER_NOTICE_EMOJI_GROUPS");
    expect(noticeSource).not.toContain("DEFAULT_ICON");

    expect(apiSource).toContain("titleRuns?: BannerTitleRun[]");
    expect(apiSource).toContain("noticeType?: BannerNoticeType");
    expect(apiSource).not.toContain("icon?:");
    expect(apiSource).toContain("export type { BannerTitleRun }");
});
