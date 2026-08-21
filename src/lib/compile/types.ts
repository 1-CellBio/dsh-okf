export type CompilePaper = {
  title: string;
  published?: string;
  doi?: string;
  authors?: string[];
  venue?: string;
  description?: string;
  tags?: string[];
  body: string;
};

export type CompileConcept = {
  title: string;
  body: string;
  tags?: string[];
};

export type CompileClaim = {
  title: string;
  quote: string;
  stance?: string;
  body?: string;
};

export type CompileOutput = {
  paper: CompilePaper;
  topics: CompileConcept[];
  methods: CompileConcept[];
  entities: CompileConcept[];
  datasets: CompileConcept[];
  genes: CompileConcept[];
  pathways: CompileConcept[];
  claims: CompileClaim[];
};

/** Continuation-pass payload (no bibliography). */
export type CompileSegmentOutput = {
  additions?: string;
  topics: CompileConcept[];
  methods: CompileConcept[];
  entities: CompileConcept[];
  datasets: CompileConcept[];
  genes: CompileConcept[];
  pathways: CompileConcept[];
  claims: CompileClaim[];
};
