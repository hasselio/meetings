// «Acme Bygg AS» → «acme-bygg-as», brukt i bedriftens egen lenke (/b/acme-bygg-as).
function slugify(value) {
  return (
    String(value || '')
      .toLowerCase()
      .replace(/æ/g, 'ae')
      .replace(/ø/g, 'o')
      .replace(/å/g, 'a')
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'bedrift'
  );
}

const isSlug = (value) => /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(value || '');

module.exports = { slugify, isSlug };
