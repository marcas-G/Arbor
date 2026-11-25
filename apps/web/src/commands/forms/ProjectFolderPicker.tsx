import { useRef, useState } from "react";
import {
  browseProjectDirectories,
  type ProjectDirectoryListing,
} from "../../api/projectDirectories.js";
import { Button } from "../../components/Button.js";
import { Field } from "../../components/Field.js";

export function ProjectFolderPicker({
  token,
  path,
  create,
  disabled,
  onPathChange,
  onCreateChange,
}: {
  readonly token: string;
  readonly path: string;
  readonly create: boolean;
  readonly disabled: boolean;
  readonly onPathChange: (path: string) => void;
  readonly onCreateChange: (create: boolean) => void;
}) {
  const [listing, setListing] = useState<ProjectDirectoryListing | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const browse = async (target?: string): Promise<void> => {
    const requestGeneration = ++generation.current;
    setBrowsing(true);
    setLoading(true);
    setError(null);
    try {
      const next = await browseProjectDirectories(token, target);
      if (requestGeneration !== generation.current) return;
      setListing(next);
    } catch (failure) {
      if (requestGeneration !== generation.current) return;
      setError(failure instanceof Error ? failure.message : "无法读取目录。");
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  };
  return (
    <div className="grid min-w-0 gap-ui-2">
      <Field
        control="input"
        label="项目目录"
        value={path}
        disabled={disabled}
        placeholder="输入完整路径，或点击浏览选择文件夹"
        onChange={onPathChange}
      />
      <div className="flex flex-wrap gap-ui-2">
        <Button
          disabled={disabled}
          onClick={() => void browse(path || undefined)}
        >
          浏览文件夹
        </Button>
        <label>
          <input
            type="checkbox"
            checked={create}
            disabled={disabled}
            onChange={(event) => onCreateChange(event.target.checked)}
          />
          新建此文件夹
        </label>
      </div>
      <p className="m-0 text-caption text-muted-foreground">
        路径位于运行 Arbor 服务的机器上。已有文件会保留。
      </p>
      {create ? (
        <p className="m-0 text-caption text-muted-foreground">
          将在上述位置新建文件夹；父目录需要已经存在。
        </p>
      ) : null}
      {browsing ? (
        <fieldset
          disabled={disabled}
          className="grid min-w-0 gap-ui-2 rounded-sm border border-solid border-border p-ui-3"
        >
          <legend>选择文件夹</legend>
          <div className="flex flex-wrap gap-ui-2">
            <Button disabled={loading} onClick={() => void browse()}>
              主目录
            </Button>
            <Button
              disabled={
                loading || listing === null || listing.parent === listing.path
              }
              onClick={() => void browse(listing?.parent)}
            >
              上级目录
            </Button>
            <Button
              onClick={() => {
                generation.current += 1;
                setBrowsing(false);
                setLoading(false);
              }}
            >
              收起
            </Button>
          </div>
          {loading ? (
            <p role="status" className="m-0 text-muted-foreground">
              正在读取目录…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="m-0 text-destructive">
              {error}
            </p>
          ) : null}
          {listing !== null && !loading && error === null ? (
            <>
              <p className="m-0 wrap-anywhere font-mono text-foreground">
                {listing.path}
              </p>
              <Button
                onClick={() => {
                  onPathChange(listing.path);
                  onCreateChange(false);
                  setBrowsing(false);
                }}
              >
                使用此文件夹
              </Button>
              <ul className="m-0 grid max-h-72 list-none overflow-y-auto p-0">
                {listing.entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className="w-full wrap-anywhere border-0 bg-card p-ui-2 text-left font-sans text-foreground hover:bg-accent"
                      onClick={() => void browse(entry.path)}
                    >
                      {entry.name} /
                    </button>
                  </li>
                ))}
              </ul>
              {listing.entries.length === 0 ? (
                <p className="m-0 text-muted-foreground">
                  没有子文件夹，可使用当前文件夹。
                </p>
              ) : null}
              {listing.truncated ? (
                <p className="m-0 text-muted-foreground">
                  目录较多，仅显示部分结果；可直接输入更具体的路径。
                </p>
              ) : null}
            </>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  );
}
