"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MediaCard } from "@/components/media-card";
import { MediaFilters } from "@/components/media-filters";
import { LibraryToolbar } from "@/components/library-toolbar";
import { Music, Disc3, ListMusic, HardDrive } from "lucide-react";
import { useCardSize } from "@/hooks/use-card-size";
import { useServers } from "@/hooks/use-servers";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { formatFileSize } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";
import { MediaGridSkeleton } from "@/components/skeletons";

interface AlbumEntry {
  albumTitle: string;
  artistName: string;
  trackCount: number;
  totalSize: string;
  audioCodecCounts: Record<string, number>;
  mediaItemId: string;
}

const SORT_OPTIONS = [
  { value: "albumTitle", label: "Name" },
  { value: "artistName", label: "Artist" },
  { value: "trackCount", label: "Tracks" },
  { value: "totalSize", label: "Size" },
];

export default function AllAlbumsPage() {
  const router = useRouter();
  const [albums, setAlbums] = useState<AlbumEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sortBy, setSortBy] = useState("albumTitle");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");

  const { size, setSize, gridStyle } = useCardSize();
  const { servers, selectedServerId, setSelectedServerId } = useServers();

  const fetchAlbums = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", "0");
      params.set("sortBy", sortBy);
      params.set("sortOrder", sortOrder);
      if (selectedServerId !== "all") {
        params.set("serverId", selectedServerId);
      }
      for (const [key, value] of Object.entries(filters)) {
        if (value) params.set(key, value);
      }
      const response = await fetch(`/api/media/music/albums/all?${params}`);
      const data = await response.json();
      setAlbums(data.albums || []);
    } catch (error) {
      console.error("Failed to fetch albums:", error);
    } finally {
      setLoading(false);
    }
  }, [filters, sortBy, sortOrder, selectedServerId]);

  useEffect(() => {
    const timeout = setTimeout(() => fetchAlbums(), 300);
    return () => clearTimeout(timeout);
  }, [fetchAlbums]);

  const toggleSort = (field: string) => {
    if (sortBy === field) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortOrder("asc");
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight mb-4">
        Music
      </h1>

      <nav className="mb-6 flex items-center gap-1 border-b overflow-x-auto">
        <Link
          href="/library/music"
          className="flex items-center gap-2 border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-muted-foreground/30 transition-colors"
        >
          <Music className="h-4 w-4" />
          Artists
        </Link>
        <Link
          href="/library/music/albums"
          className="flex items-center gap-2 border-b-2 border-primary px-4 py-2 text-sm font-medium text-foreground"
        >
          <Disc3 className="h-4 w-4" />
          All Albums
        </Link>
        <Link
          href="/library/music/tracks"
          className="flex items-center gap-2 border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-muted-foreground/30 transition-colors"
        >
          <ListMusic className="h-4 w-4" />
          All Tracks
        </Link>
      </nav>

      <MediaFilters
        onFilterChange={setFilters}
        mediaType="MUSIC"
        prefix={
          <LibraryToolbar
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            cardSize={size}
            onCardSizeChange={setSize}
            servers={servers}
            selectedServerId={selectedServerId}
            onServerChange={setSelectedServerId}
            sortOptions={SORT_OPTIONS}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSortChange={(v) => toggleSort(v)}
            onSortOrderToggle={() => setSortOrder((o) => (o === "asc" ? "desc" : "asc"))}
          />
        }
      />

      {loading ? (
        <MediaGridSkeleton />
      ) : albums.length === 0 ? (
        <EmptyState icon={Disc3} title="No albums found." />
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            {albums.length} {albums.length === 1 ? "album" : "albums"}
          </p>

          <div style={gridStyle}>
            {albums.map((album) => (
              <MediaCard
                key={`${album.artistName}::${album.albumTitle}`}
                imageUrl={`/api/media/${album.mediaItemId}/image?type=parent`}
                title={album.albumTitle}
                aspectRatio="square"
                fallbackIcon="music"
                onClick={() =>
                  router.push(`/library/music/album/${album.mediaItemId}`)
                }
                metadata={
                  <MetadataLine stacked>
                    <MetadataItem icon={<Music />}>
                      {album.artistName}
                    </MetadataItem>
                    <MetadataItem icon={<ListMusic />}>
                      {album.trackCount}{" "}
                      {album.trackCount === 1 ? "track" : "tracks"}
                    </MetadataItem>
                    <MetadataItem icon={<HardDrive />}>
                      {formatFileSize(album.totalSize)}
                    </MetadataItem>
                  </MetadataLine>
                }
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
