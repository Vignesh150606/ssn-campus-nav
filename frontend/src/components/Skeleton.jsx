/**
 * Skeleton — pulse placeholder block. Use width/height props or className
 * to size; defaults to a full-width text-row sized block.
 */
export default function Skeleton({ width, height, radius, className = '', style = {} }) {
  return (
    <span
      aria-hidden="true"
      className={`skeleton ${className}`}
      style={{
        width: width || '100%',
        height: height || 14,
        borderRadius: radius != null ? radius : 6,
        ...style,
      }}
    />
  )
}

export function SkeletonRoutePreview() {
  return (
    <div className="skeleton-route-preview" aria-busy="true" aria-label="Finding route">
      <Skeleton width="40%" height={10} />
      <Skeleton width="75%" height={26} style={{ marginTop: 6 }} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
        <Skeleton height={62} radius={14} />
        <Skeleton height={62} radius={14} />
      </div>
      <Skeleton width="35%" height={10} style={{ marginTop: 16 }} />
      <Skeleton height={36} style={{ marginTop: 10 }} />
      <Skeleton height={36} style={{ marginTop: 4 }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
        <Skeleton height={52} radius={14} style={{ flex: '0 0 130px' }} />
        <Skeleton height={52} radius={14} style={{ flex: 1 }} />
      </div>
    </div>
  )
}

export function SkeletonScheduleList({ count = 4 }) {
  return (
    <div aria-busy="true" aria-label="Loading schedule">
      {Array.from({ length: count }).map((_, i) => (
        <div className="skeleton-schedule-card" key={i}>
          <Skeleton width={90} height={18} radius={999} />
          <Skeleton width="70%" height={20} style={{ marginTop: 10 }} />
          <div style={{ display: 'flex', gap: 18, marginTop: 12 }}>
            <Skeleton width={80} height={12} />
            <Skeleton width={70} height={12} />
            <Skeleton width={70} height={12} />
          </div>
        </div>
      ))}
    </div>
  )
}
