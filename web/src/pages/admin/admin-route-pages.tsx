import { Button } from "antd";
import { Plus, Settings2, UserRoundCog } from "lucide-react";
import { lazy, useState } from "react";

import { useAdminContext } from "./admin-context";
import { AdminPageFrame } from "./components/admin-shell";
import { readAnnouncementPendingReview } from "./components/admin-announcement-safety";

const AnalyticsPanel = lazy(() => import("./components/analytics-panel"));
const AdminAnnouncementsPanel = lazy(() => import("./components/admin-announcements-panel"));
const AdminBannerAnnouncementsPanel = lazy(() => import("./components/admin-banner-announcements-panel"));
const FeatureAvailabilityPanel = lazy(() => import("./components/feature-availability-panel"));
const StorageResourcesPanel = lazy(() => import("./components/storage-resources-panel"));

export function AnalyticsPage() {
    const { references } = useAdminContext();
    return (
        <AdminPageFrame title="数据概览" description="用户、任务、质量与成本健康度" scroll>
            <AnalyticsPanel users={references.users} channels={references.channels} />
        </AdminPageFrame>
    );
}

export function AnnouncementsPage() {
    const [publishOpen, setPublishOpen] = useState(false);
    const [publishBlocked, setPublishBlocked] = useState(() => Boolean(readAnnouncementPendingReview()));
    const [publishReturnFocus, setPublishReturnFocus] = useState<HTMLElement | null>(null);
    return (
        <AdminPageFrame
            title="系统公告"
            description="面向全体用户的通知发布与状态管理"
            actions={
                <Button
                    id="admin-announcement-publish-trigger"
                    type="primary"
                    disabled={publishBlocked}
                    title={publishBlocked ? "请先核对上一次结果不确定的发布请求" : undefined}
                    icon={<Plus className="size-4" />}
                    onClick={(event) => {
                        setPublishReturnFocus(event.currentTarget);
                        setPublishOpen(true);
                    }}
                >
                    发布公告
                </Button>
            }
        >
            <AdminAnnouncementsPanel publishOpen={publishOpen} publishBlocked={publishBlocked} publishReturnFocus={publishReturnFocus} onPublishOpenChange={setPublishOpen} onPublishBlockedChange={setPublishBlocked} />
        </AdminPageFrame>
    );
}

export function BannerAnnouncementsPage() {
    const [createOpen, setCreateOpen] = useState(false);
    return (
        <AdminPageFrame
            title="常驻通知"
            description="配置首页顶部常驻展示的通知，支持标题、状态与有效期"
            actions={
                <Button
                    type="primary"
                    icon={<Plus className="size-4" />}
                    onClick={() => setCreateOpen(true)}
                >
                    新增常驻通知
                </Button>
            }
        >
            <AdminBannerAnnouncementsPanel createOpen={createOpen} onCreateOpenChange={setCreateOpen} />
        </AdminPageFrame>
    );
}





export function FeatureAvailabilityPage() {
    return (
        <AdminPageFrame title="功能开放" description="按使用路径控制工作台入口与插件开放范围" scroll>
            <FeatureAvailabilityPanel />
        </AdminPageFrame>
    );
}

export function StorageResourcesPage() {
    return (
        <AdminPageFrame title="存储资源" description="只读查看资源记录、容量分布与文件预览" scroll>
            <StorageResourcesPanel />
        </AdminPageFrame>
    );
}

