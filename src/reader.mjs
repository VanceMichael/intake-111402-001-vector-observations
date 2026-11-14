export async function collect(client) {
  const stream = await client('/streams/air');
  const page = await client('/observations?stream=air&page=1');
  return page.items.filter(item => item.definition === stream.definition && item.result.length === stream.components.length)
    .map(item => ({id:item.observationId, time:item.phenomenonTime,
      values:stream.components.map((component,index) => ({...component,value:item.result[index]})), locationRef:item.locationRef}));
}
