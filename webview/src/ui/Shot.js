function Shot({ dataUrl, width, height, cap, failed }) {
  if (!dataUrl) return <>{failed}</>;
  return (
    <>
      <img src={dataUrl} width={width || undefined} height={height || undefined} />
      <div className="cap">{cap}</div>
    </>
  );
}

module.exports = { Shot };
